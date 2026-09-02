import { OnPanelLoad, PanelHandler } from 'util/module-helpers';
import AuthenicationResult = MomentumAPI.AuthenicationResult;
import { Role } from 'common/web/enums/role.enum';

export enum Page {
	MAP_SELECTOR = 'MapSelection',
	LEARN = 'Learn',
	SETTINGS = 'Settings',
	CONTROLS_LIBRARY = 'ControlsLibrary'
}

// Values stored in persistent `settings.mainMenuBackground`.
enum BackgroundMode {
	LIGHT = 0,
	DARK = 1,
	CSS = 2 // custom static background01 (no video variant)
}

// Persistent key holding a user-picked background FILE NAME (with extension) that overrides the themed
// default. Empty / absent = no override. `.webm` → played from videos/backgrounds; any image extension →
// shown from images/backgrounds.
const BG_OVERRIDE_KEY = 'settings.mainMenuBackgroundOverride';

// Image file extensions the selector accepts (Panorama can't list a folder, so we route by extension).
const BG_IMAGE_EXTS = ['dds', 'png', 'tga', 'jpg', 'jpeg', 'vtex'];

// Known files shipped in videos/backgrounds and images/backgrounds, offered as quick-pick buttons.
// NOT exhaustive — the name input accepts any file present in those folders. Keep in sync if you add art.
const KNOWN_BACKGROUNDS: string[] = [
	'MomentumLight.webm',
	'MomentumDark.webm',
	'MomentumXmas.webm',
	'background01.dds',
	'background_triple.png',
	'MomentumNeutral_4K.png'
];

// nekos.best anime-image API — powers the background selector's image search. No auth (the engine's
// default User-Agent satisfies it) and PNG images (which render as a background, unlike webp APIs). The
// `/search?query=&type=1` endpoint does keyword search; the 4 PNG categories browse random images (the
// ~58 GIF categories are skipped — a static background wants a still image). The JSON call needs
// `nekos.best` in domain_whitelist.kv3; the image display via SetImage is not whitelist-gated. See §6d.
const NEKOS_BEST_API = 'https://nekos.best/api/v2';
const NEKO_CATEGORIES = ['neko', 'waifu', 'husbando', 'kitsune'];
const NEKO_RESULT_COUNT = 15; // results per search / browse (API max is 20)

@PanelHandler()
class MainMenuHandler implements OnPanelLoad {
	readonly panels = {
		cp: $.GetContextPanel<MainMenu>(),
		pageContent: $<Panel>('#PageContent'),
		homeContent: $<Panel>('#HomeContent'),
		contentBlur: $<BaseBlurTarget>('#MainMenuContentBlur'),
		backgroundBlur: $<BaseBlurTarget>('#MainMenuBackgroundBlur'),
		movie: null as Movie,
		image: $<Image>('#MainMenuBackground'),
		model: $<ModelPanel>('#MainMenuModel'),
		mapSelectorBackground: $<Image>('#MainMenuBackgroundMapSelectorImage'),
		topButtons: $<Panel>('#MainMenuTopButtons'),
		homeButton: $<RadioButton>('#HomeButton'),
		quitButtonIcon: $<Image>('#QuitButtonImage'),
		legal: $<Panel>('#LegalConsent')
	};

	activePage: Page | null = null;

	// File name currently being validated on the hidden probe Image (background selector).
	pendingBackground: string | null = null;

	// Bumped on each nekos.best request so a slower earlier one that resolves late is discarded.
	nekoGen = 0;

	constructor() {
		$.RegisterForUnhandledEvent('ShowMainMenu', () => this.onShowMainMenu());
		$.RegisterForUnhandledEvent('HideMainMenu', () => this.onHideMainMenu());
		$.RegisterForUnhandledEvent('ShowPauseMenu', () => this.onShowPauseMenu());
		$.RegisterForUnhandledEvent('HidePauseMenu', () => this.onHidePauseMenu());
		$.RegisterForUnhandledEvent('MapSelector_OnLoaded', () => this.onMapSelectorLoaded());
		$.RegisterForUnhandledEvent('ReloadMainMenuBackground', () => this.setMainMenuBackground());
		// Lets custom pages in their own script context (e.g. the CS:S map selector) close back to the menu.
		$.RegisterForUnhandledEvent('MainMenu_ClosePage', () => this.hideMainMenuPageContent());
		$.RegisterForUnhandledEvent('OnMomentumQuitPrompt', () => this.onQuitPrompt());
		$.RegisterForUnhandledEvent('MomAPI_Authenticated', (result) => this.onAuthenticated(result));
		$.RegisterEventHandler('Cancelled', $.GetContextPanel(), () => this.onEscapeKeyPressed());

		// Close the map selector when a map is loaded
		$.RegisterForUnhandledEvent('LevelInitPostEntity', () => this.hideMainMenuPageContent());

		$.DispatchEvent('HideIntroMovie');
	}

	async onPanelLoad() {
		// These aren't accessible until the page has loaded fully, find them now
		this.panels.movie = $('#MainMenuMovie');
		this.panels.model = $('#MainMenuModel');

		this.panels.model.SetModelRotation(0, 270, 0); // Get arrow logo facing to the right, looks better
		this.panels.model.SetModelRotationSpeedTarget(0, 0.2, 0);
		this.panels.model.SetMouseXRotationScale(0, 1, 0); // By default mouse X will rotate the X axis, but we want it to spin Y axis
		this.panels.model.SetMouseYRotationScale(0, 0, 0); // Disable mouse Y movement rotations

		this.panels.model.LookAtModel();
		this.panels.model.SetCameraOffset(-200, 0, 0);
		this.panels.model.SetCameraFOV(40);

		this.panels.model.SetDirectionalLightColor(0, 0.5, 0.5, 0.5);
		this.panels.model.SetDirectionalLightDirection(0, 1, 0, 0);

		if (GameInterfaceAPI.GetSettingBool('developer')) {
			$('#ControlsLibraryButton').RemoveClass('hide');
		}

		this.setMainMenuBackground();

		// Background selector: validate typed image names on a hidden probe. PanelLoaded ⇒ the file
		// exists (apply it); ImageFailedLoad ⇒ it doesn't (show a "not found" error). See §6d.
		const probe = $<Image>('#BackgroundProbe');
		if (probe) {
			$.RegisterEventHandler('PanelLoaded', probe, () => this.onBackgroundProbeLoaded());
			$.RegisterEventHandler('ImageFailedLoad', probe, () => this.onBackgroundProbeFailed());
		}

		await this.checkUserLegalConsent();

		this.showPlaytestWelcomePopup();

		$.DispatchEvent('MainMenuPageShown', null);

		// Pre-create the Stats page (hidden) shortly after the menu loads, so it scans the map cache
		// and pre-fetches leaderboard ranks in the background before the user ever opens it.
		// Opt-in only (off by default) — toggled from the Stats page and saved to persistent storage.
		if ($.persistentStorage.getItem('stats.preloadEnabled')) {
			$.Msg('[Stats] main-menu onPanelLoad: preload enabled, scheduling Stats pre-warm in 4s');
			$.Schedule(4, () => this.preloadStatsPage());
		} else {
			$.Msg('[Stats] main-menu onPanelLoad: Stats preload disabled (enable it on the Stats page)');
		}
	}

	/** Instantiate the Stats page hidden so its background scan starts on menu load, not first open. */
	preloadStatsPage() {
		const page = 'Stats' as Page;
		if (this.panels.cp.FindChildInLayoutFile(page)) {
			$.Msg('[Stats] preloadStatsPage: panel already exists, skipping pre-warm');
			return; // already created
		}

		$.Msg('[Stats] preloadStatsPage: creating hidden Stats panel + loading layout');
		const newPanel = $.CreatePanel('Panel', this.panels.pageContent, page);
		newPanel.LoadLayout('file://{resources}/layout/pages/stats/stats.xml', false, false);
		newPanel.RegisterForReadyEvents(true);
		$.RegisterEventHandler('PropertyTransitionEnd', newPanel, (panelName, propertyName) => {
			if (
				newPanel.id === panelName &&
				propertyName === 'opacity' &&
				newPanel.visible &&
				newPanel.IsTransparent()
			) {
				newPanel.visible = false;
				newPanel.SetReadyForDisplay(false);
				return true;
			}
			return false;
		});
		// Keep it hidden until the user actually navigates to it.
		newPanel.visible = false;
		newPanel.AddClass('mainmenu__page-container--hidden');
	}

	/**
	 * Fired by C++ whenever main menu is switched to.
	 */
	onShowMainMenu() {
		this.panels.movie = $('#MainMenuMovie');
		this.panels.image = $('#MainMenuBackground');

		this.panels.quitButtonIcon.SetImage('file://{images}/quit.svg');

		this.setMainMenuBackground();
	}

	/**
	 * Fired by C++ whenever main menu is switched from.
	 */
	onHideMainMenu() {
		UiToolkitAPI.CloseAllVisiblePopups();
	}

	/**
	 * Fired by C++ whenever pause menu (i.e. main menu when in a map) is switched to.
	 */
	onShowPauseMenu() {
		this.panels.cp.AddClass('MainMenuRootPanel--PauseMenuMode');

		this.panels.quitButtonIcon.SetImage('file://{images}/exit-door.svg');
	}

	/**
	 * Fired by C++ whenever pause menu is switched from.
	 */
	onHidePauseMenu() {
		this.panels.cp.RemoveClass('MainMenuRootPanel--PauseMenuMode');

		// Save to file whenever the settings page gets closed
		if (this.activePage === Page.SETTINGS) {
			$.DispatchEvent('SettingsSave');
		}
	}

	/**
	 * Switch main menu page
	 */
	navigateToPage(page: Page, layoutFile: string, hasBlur = true) {
		this.panels.mapSelectorBackground.SetHasClass('mapselector__background--hidden', page !== Page.MAP_SELECTOR);

		this.panels.contentBlur.visible = hasBlur;

		if (this.activePage === page) {
			$.DispatchEvent('Activated', this.panels.homeButton, PanelEventSource.MOUSE);
			return;
		}

		// Check to see if page to show exists. If not load the xml file.
		if (!this.panels.cp.FindChildInLayoutFile(page)) {
			const newPanel = $.CreatePanel('Panel', this.panels.pageContent, page);

			newPanel.LoadLayout(`file://{resources}/layout/pages/${layoutFile}.xml`, false, false);
			newPanel.RegisterForReadyEvents(true);

			// Handler that catches PropertyTransitionEndEvent event for this panel.
			// Check if the panel is transparent then collapse it.
			$.RegisterEventHandler('PropertyTransitionEnd', newPanel, (panelName, propertyName) => {
				// Panel is visible and fully transparent
				if (
					newPanel.id === panelName &&
					propertyName === 'opacity' &&
					newPanel.visible &&
					newPanel.IsTransparent()
				) {
					// Set visibility to false and unload resources
					newPanel.visible = false;
					newPanel.SetReadyForDisplay(false);
					return true;
				}
				return false;
			});
		}

		// If we have an active tab and it is different from the selected tab, hide it.
		// Then show the selected tab.
		if (this.activePage !== page) {
			// If the tab exists then hide it
			if (this.activePage) {
				const pagePanel = this.panels.cp.FindChildInLayoutFile(this.activePage);
				pagePanel.visible = false;
				pagePanel.AddClass('mainmenu__page-container--hidden');
				$.DispatchEvent('MainMenuPageHidden', this.activePage);
			}

			// Show selected page
			this.activePage = page;
			const activePanel = this.panels.cp.FindChildInLayoutFile(page);
			activePanel.RemoveClass('mainmenu__page-container--hidden');
			$.DispatchEvent('MainMenuPageShown', page);

			// Force a reload of any resources since we're about to display the panel
			activePanel.visible = true;
			activePanel.SetReadyForDisplay(true);
		}

		this.showMainMenuPageContent();
	}

	/**
	 * Show the main menu page container and retract the drawer.
	 */
	showMainMenuPageContent() {
		this.panels.pageContent.RemoveClass('mainmenu__page-container--hidden');

		$.DispatchEvent('RetractDrawer');

		this.panels.homeContent.AddClass('home--hidden');
	}

	/**
	 * Hide the main menu page container and active page, and display the home page content.
	 */
	hideMainMenuPageContent() {
		this.panels.pageContent.AddClass('mainmenu__page-container--hidden');
		this.panels.mapSelectorBackground.AddClass('mapselector__background--hidden');

		// Uncheck the active button in the main menu navbar.
		const activeButton = this.panels.topButtons.Children().find((panel) => panel.IsSelected());
		if (activeButton && activeButton.id !== 'HomeButton') {
			activeButton.checked = false;
		}

		// If the tab exists then hide it
		if (this.activePage) {
			const panelToHide = this.panels.cp.FindChildInLayoutFile(this.activePage);
			if (panelToHide) panelToHide.AddClass('mainmenu__page-container--hidden');

			$.DispatchEvent('MainMenuPageHidden', this.activePage);
		}

		$.DispatchEvent('MainMenuPageShown', null);
		this.activePage = null;
		this.panels.homeContent.RemoveClass('home--hidden');
	}

	/**
	 * Temporary method to show the playtest welcome thingy
	 */
	showPlaytestWelcomePopup() {
		if (!$.persistentStorage.getItem('mainMenu.playtestWelcomeShown')) {
			UiToolkitAPI.ShowCustomLayoutPopup('', 'file://{resources}/layout/modals/popups/playtest-welcome.xml');
		}
	}

	/**
	 * Set the video background based on persistent storage settings
	 */
	setMainMenuBackground() {
		if (!this.panels.movie?.IsValid() || !this.panels.image?.IsValid()) return;

		let useVideo = $.persistentStorage.getItem<boolean>('settings.mainMenuMovie');

		if (useVideo === null) {
			// Enable video by default
			useVideo = true;
			$.persistentStorage.setItem('settings.mainMenuMovie', true);
		}

		let backgroundVar = Number.parseInt($.persistentStorage.getItem('settings.mainMenuBackground'));

		if (Number.isNaN(backgroundVar)) {
			// Set color mode by system preference
			backgroundVar = $.SystemInDarkMode() ? 1 : 0;
			$.persistentStorage.setItem('settings.mainMenuBackground', backgroundVar);
		}

		// The CSS mode gets a CS:S-style menu: the class drives all the show/hide via CSS (hides the top
		// nav, spinning logo, news, and the other bottombar buttons; shows #CssMenu), scoped so the
		// pause-menu nav is left alone. The lobby drawer is untouched. Independent of any background override.
		const cssMode = backgroundVar === BackgroundMode.CSS;
		if (this.panels.cp?.IsValid()) this.panels.cp.SetHasClass('mainmenu--css', cssMode);

		// 1) A user-chosen background override (picked in the background selector) wins over the themed
		//    default. A full http(s) URL (e.g. a nekos.best image) is shown directly; a `.webm` name → video;
		//    any other image name → static image from images/backgrounds.
		const override = $.persistentStorage.getItem<string>(BG_OVERRIDE_KEY);
		if (override) {
			if (this.isRemoteUrl(override)) this.showBackgroundImageUrl(override);
			else if (this.isVideoFile(override)) this.showBackgroundVideo(override);
			else this.showBackgroundImage(override);
			return;
		}

		// 2) CSS mode's default is the custom static background01 (no video variant).
		if (cssMode) {
			this.showBackgroundImage('background01.dds');
			return;
		}

		// 3) Otherwise the themed Momentum background (seasonal swap near Christmas), video or static.
		let name: string;
		const date = new Date();
		if (date.getMonth() === 11 && date.getDate() >= 18) {
			name = 'MomentumXmas';
		} else {
			name = backgroundVar === BackgroundMode.DARK ? 'MomentumDark' : 'MomentumLight';
		}

		if (useVideo) this.showBackgroundVideo(`${name}.webm`);
		else this.showBackgroundImage(`${name}.dds`);
	}

	/** True if `file` is a video (webm) rather than a static image, by extension. */
	isVideoFile(file: string): boolean {
		return file.split('.').pop()?.toLowerCase() === 'webm';
	}

	/** Show `file` (in videos/backgrounds) as the animated movie background. */
	showBackgroundVideo(file: string) {
		this.panels.movie.visible = true;
		this.panels.movie.SetReadyForDisplay(true);
		this.panels.image.visible = false;
		this.panels.image.SetReadyForDisplay(false);
		this.panels.movie.SetMovie(`file://{resources}/videos/backgrounds/${file}`);
		this.panels.movie.Play();
	}

	/** Show `file` (in images/backgrounds) as the static image background. */
	showBackgroundImage(file: string) {
		this.panels.movie.visible = false;
		this.panels.movie.SetReadyForDisplay(false);
		this.panels.image.visible = true;
		this.panels.image.SetReadyForDisplay(true);
		this.panels.image.SetImage(`file://{images}/backgrounds/${file}`);
	}

	/** True if `s` is a remote http(s) URL (e.g. a nekos.best image) rather than a local file name. */
	isRemoteUrl(s: string): boolean {
		return /^https?:\/\//i.test(s);
	}

	/** Show a remote image `url` (e.g. a nekos.best search result) as the static background. SetImage takes
	 *  a CDN url directly and, unlike $.AsyncWebRequest, is NOT domain-whitelist-gated. */
	showBackgroundImageUrl(url: string) {
		this.panels.movie.visible = false;
		this.panels.movie.SetReadyForDisplay(false);
		this.panels.image.visible = true;
		this.panels.image.SetReadyForDisplay(true);
		this.panels.image.SetImage(url);
	}

	// --- Background selector (name input + quick-picks) -------------------------------------------------
	// Panorama can't enumerate a folder from JS, so the selector is a name input: type a file name (with
	// extension) from videos/backgrounds or images/backgrounds. Image names are validated on the preview
	// Image (ImageFailedLoad ⇒ "not found"); webm names can't be probed, so they're applied directly.

	/** Open the selector overlay (reachable from the bottombar and the CS:S menu). */
	openBackgroundSelector() {
		const sel = $('#BackgroundSelector');
		if (!sel) return;
		sel.AddClass('bgselector--open'); // show first, so the preview Image below actually renders/loads
		this.populateBackgroundPresets();
		this.setBackgroundStatus('', false);
		const current = $.persistentStorage.getItem<string>(BG_OVERRIDE_KEY) ?? '';
		const input = $<TextEntry>('#BackgroundNameInput');
		if (input) input.text = this.isRemoteUrl(current) ? '' : current; // don't dump a long URL into the name box
		// Preview the current image (the probe's PanelLoaded fires but pendingBackground is null → no-op).
		const probe = $<Image>('#BackgroundProbe');
		if (probe && current) {
			if (this.isRemoteUrl(current)) probe.SetImage(current);
			else if (!this.isVideoFile(current)) probe.SetImage(`file://{images}/backgrounds/${current}`);
		}

		// Anime-image search: build the category quick-picks and load a first batch so the grid isn't empty.
		this.populateNekoCategories();
		this.setNekoStatus('', false);
		const nekoInput = $<TextEntry>('#NekoSearchInput');
		if (nekoInput) nekoInput.text = '';
		this.browseNekoCategory('neko');
	}

	closeBackgroundSelector() {
		const sel = $('#BackgroundSelector');
		if (sel) sel.RemoveClass('bgselector--open');
	}

	/** (Re)build the quick-pick buttons for the known files, highlighting the active one. */
	populateBackgroundPresets() {
		const holder = $('#BackgroundSelectorPresets');
		if (!holder) return;
		holder.RemoveAndDeleteChildren();
		const current = $.persistentStorage.getItem<string>(BG_OVERRIDE_KEY) ?? '';
		for (const file of KNOWN_BACKGROUNDS) {
			const btn = $.CreatePanel('Button', holder, `BgPreset_${file.replace(/\W/g, '_')}`, {
				class: 'bgselector__preset'
			});
			if (file === current) btn.AddClass('bgselector__preset--active');
			btn.SetPanelEvent('onactivate', () => {
				const input = $<TextEntry>('#BackgroundNameInput');
				if (input) input.text = file;
				this.applyBackgroundByName();
			});
			$.CreatePanel('Label', btn, '', { class: 'bgselector__preset-text', text: file });
		}
	}

	/** Apply the name typed in the input, validating image names and erroring if the file isn't found. */
	applyBackgroundByName() {
		const input = $<TextEntry>('#BackgroundNameInput');
		const name = (input?.text ?? '').trim();
		if (!name) {
			this.setBackgroundStatus('Enter a background file name.', true);
			return;
		}

		// A pasted remote image URL (e.g. from the anime search, or any direct link) is applied as-is.
		if (this.isRemoteUrl(name)) {
			this.commitBackgroundOverride(name);
			this.setBackgroundStatus('Applied image URL.', false);
			return;
		}

		const ext = name.split('.').pop()?.toLowerCase() ?? '';

		if (ext === 'webm') {
			// A movie can't be probed for existence, so apply it directly. If the file is missing the
			// background simply won't play (images below get real not-found detection).
			this.commitBackgroundOverride(name);
			this.setBackgroundStatus(`Applied "${name}".`, false);
			return;
		}

		if (!BG_IMAGE_EXTS.includes(ext)) {
			this.setBackgroundStatus('Add a file extension: .webm, .dds, .png, .tga or .jpg', true);
			return;
		}

		// Validate the image by loading it into the preview first; its PanelLoaded / ImageFailedLoad
		// handlers (registered in onPanelLoad) commit it or report "not found".
		const probe = $<Image>('#BackgroundProbe');
		if (!probe) {
			this.commitBackgroundOverride(name); // no preview available — apply without validating
			this.setBackgroundStatus(`Applied "${name}".`, false);
			return;
		}
		this.pendingBackground = name;
		this.setBackgroundStatus(`Checking "${name}"…`, false);
		probe.SetImage(`file://{images}/backgrounds/${name}`);
	}

	onBackgroundProbeLoaded() {
		if (!this.pendingBackground) return;
		const name = this.pendingBackground;
		this.pendingBackground = null;
		this.commitBackgroundOverride(name);
		this.setBackgroundStatus(`Applied "${name}".`, false);
	}

	onBackgroundProbeFailed() {
		if (!this.pendingBackground) return;
		const name = this.pendingBackground;
		this.pendingBackground = null;
		this.setBackgroundStatus(`"${name}" not found in images/backgrounds.`, true);
	}

	/** Persist the override file name and repaint the background + preset highlights. */
	commitBackgroundOverride(file: string) {
		$.persistentStorage.setItem(BG_OVERRIDE_KEY, file);
		this.setMainMenuBackground();
		this.populateBackgroundPresets();
		$.PlaySoundEvent('MenuThemeLight');
	}

	/** Clear the override and revert to the themed (light/dark/css) background. */
	resetBackgroundOverride() {
		$.persistentStorage.setItem(BG_OVERRIDE_KEY, '');
		this.pendingBackground = null;
		this.setMainMenuBackground();
		const input = $<TextEntry>('#BackgroundNameInput');
		if (input) input.text = '';
		this.populateBackgroundPresets();
		this.setBackgroundStatus('Reverted to the theme background.', false);
	}

	setBackgroundStatus(msg: string, isError: boolean) {
		const status = $<Label>('#BackgroundSelectorStatus');
		if (!status) return;
		status.text = msg;
		status.SetHasClass('bgselector__status--error', isError && !!msg);
		status.SetHasClass('bgselector__status--hidden', !msg);
	}

	// --- Anime image search (nekos.best) --------------------------------------------------------------
	// No auth, PNG images. The keyword box hits `/search?query=&type=1`; the category quick-picks browse
	// `/{category}`. Clicking a result stores its remote URL as the background override (shown via SetImage,
	// which isn't domain-whitelist-gated). The JSON fetch DOES need `nekos.best` in domain_whitelist.kv3.

	/** Build the category quick-pick buttons (once, when the selector opens). */
	populateNekoCategories() {
		const holder = $('#NekoCategories');
		if (!holder) return;
		holder.RemoveAndDeleteChildren();
		for (const cat of NEKO_CATEGORIES) {
			const btn = $.CreatePanel('Button', holder, `NekoCat_${cat}`, { class: 'bgselector__preset' });
			btn.SetPanelEvent('onactivate', () => this.browseNekoCategory(cat));
			$.CreatePanel('Label', btn, '', { class: 'bgselector__preset-text', text: cat });
		}
	}

	/** Search box handler: keyword search, or (when empty) browse the default category. */
	searchNeko() {
		const input = $<TextEntry>('#NekoSearchInput');
		const q = (input?.text ?? '').trim();
		if (!q) {
			this.browseNekoCategory('neko');
			return;
		}
		void this.loadNeko(
			`${NEKOS_BEST_API}/search?query=${encodeURIComponent(q)}&type=1&amount=${NEKO_RESULT_COUNT}`,
			`No results for "${q}".`
		);
	}

	/** Browse random images from a nekos.best category. */
	browseNekoCategory(cat: string) {
		const input = $<TextEntry>('#NekoSearchInput');
		if (input) input.text = '';
		void this.loadNeko(`${NEKOS_BEST_API}/${cat}?amount=${NEKO_RESULT_COUNT}`, `No images in ${cat}.`);
	}

	/** Fetch a nekos.best endpoint and render the results grid. `emptyMsg` shows when it returns nothing. */
	async loadNeko(url: string, emptyMsg: string) {
		const gen = ++this.nekoGen; // supersede a slower earlier request that resolves late
		this.setNekoStatus('Searching…', false);
		try {
			const json = await this.nekoFetch(url);
			if (gen !== this.nekoGen) return; // superseded by a newer search
			const results: any[] = json?.results ?? [];
			const urls = results
				.map((r) => r?.url)
				.filter((u): u is string => typeof u === 'string' && this.isRemoteUrl(u));
			this.renderNekoResults(urls);
			this.setNekoStatus(urls.length ? `${urls.length} results — click one to apply.` : emptyMsg, !urls.length);
		} catch (e) {
			if (gen !== this.nekoGen) return;
			this.renderNekoResults([]);
			this.setNekoStatus('Search failed — is nekos.best reachable and whitelisted?', true);
			$.Msg(`[BgSelector] nekos.best request failed: ${String(e)}`);
		}
	}

	/** Render clickable thumbnails; clicking one applies it as the background. */
	renderNekoResults(urls: string[]) {
		const grid = $('#NekoResults');
		if (!grid) return;
		grid.RemoveAndDeleteChildren();
		for (const url of urls) {
			const thumb = $.CreatePanel('Image', grid, '', {
				class: 'bgselector__nekoresult',
				scaling: 'stretch-to-cover-preserve-aspect'
			});
			thumb.hittest = true; // Images default to hittest=false; ensure the click applies (not swallowed by the window)
			thumb.SetImage(url);
			thumb.SetPanelEvent('onactivate', () => this.applyNekoImage(url));
		}
	}

	/** Apply a chosen nekos.best image as the background (stored as a remote-URL override). */
	applyNekoImage(url: string) {
		this.commitBackgroundOverride(url);
		this.setNekoStatus('Applied.', false);
	}

	setNekoStatus(msg: string, isError: boolean) {
		const status = $<Label>('#NekoStatus');
		if (!status) return;
		status.text = msg;
		status.SetHasClass('bgselector__status--error', isError && !!msg);
		status.SetHasClass('bgselector__status--hidden', !msg);
	}

	/** Promise-wrapped GET + JSON parse for nekos.best. */
	nekoFetch(url: string): Promise<any> {
		return new Promise((resolve, reject) => {
			$.AsyncWebRequest(url, {
				type: 'GET',
				complete: (d) => {
					if (d.statusText !== 'success') {
						reject(d.statusText);
						return;
					}
					try {
						resolve(this.parseLeadingJson(d.responseText));
					} catch (e) {
						reject(String(e));
					}
				}
			});
		});
	}

	/** Parse the leading top-level JSON value, ignoring trailing bytes — AsyncWebRequest appends a stray
	 *  NUL terminator after the body that trips a plain JSON.parse (same quirk the Stats page handles). */
	parseLeadingJson(txt: string): any {
		let depth = 0;
		let inStr = false;
		let esc = false;
		let end = -1;
		for (let i = 0; i < txt.length; i++) {
			const c = txt[i];
			if (inStr) {
				if (esc) esc = false;
				else if (c === '\\') esc = true;
				else if (c === '"') inStr = false;
			} else if (c === '"') inStr = true;
			else if (c === '{' || c === '[') depth++;
			else if (c === '}' || c === ']') {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		return JSON.parse(end >= 0 ? txt.slice(0, end + 1) : txt);
	}

	/**
	 * Toggles the custom CSS (background01) static background on/off. Turning it off always drops to the
	 * dark theme.
	 */
	toggleCssBackground() {
		const isCss = Number.parseInt($.persistentStorage.getItem('settings.mainMenuBackground')) === BackgroundMode.CSS;
		// Clear any background override so the toggle actually changes what's on screen.
		$.persistentStorage.setItem(BG_OVERRIDE_KEY, '');
		$.persistentStorage.setItem('settings.mainMenuBackground', isCss ? BackgroundMode.DARK : BackgroundMode.CSS);
		this.setMainMenuBackground();
		$.PlaySoundEvent('MenuThemeDark');
	}

	/*
	 *	Toggles between dark and light mode in the main menu
	 */
	toggleBackgroundLightDark() {
		const isLightMode = $.persistentStorage.getItem('settings.mainMenuBackground') === 0;
		// Clear any background override so the light/dark toggle actually changes what's on screen.
		$.persistentStorage.setItem(BG_OVERRIDE_KEY, '');
		$.persistentStorage.setItem('settings.mainMenuBackground', isLightMode ? 1 : 0);
		this.setMainMenuBackground();
		$.PlaySoundEvent(isLightMode ? 'MenuThemeDark' : 'MenuThemeLight');
	}

	/**
	 * Handles the map selector load event to add blurs to some of the map selector panels.
	 * Necessary to handle in here because map selector background is a part of the main menu background section.
	 */
	onMapSelectorLoaded() {
		for (const panel of ['MapSelectorLeft', 'MapDescription', 'MapInfoStats', 'Leaderboards'])
			this.panels.backgroundBlur?.AddBlurPanel($.GetContextPanel().FindChildTraverse(panel));
	}

	/**
	 * Handles quit button getting pressed, deciding whether to `disconnect` or `quit`
	 * based on if we're ingame or not.
	 */
	onQuitButtonPressed() {
		if (GameInterfaceAPI.GetGameUIState() === GameUIState.PAUSEMENU) {
			GameInterfaceAPI.ConsoleCommand('disconnect');
			this.hideMainMenuPageContent();
			return;
		}
		this.onQuitPrompt();
	}

	/** Handles when the quit button is shown, either from button getting pressed or event fired from C++. */
	onQuitPrompt(toDesktop = true) {
		if (!toDesktop) return; // currently don't handle disconnect prompts

		$.DispatchEvent('MainMenuPauseGame'); // make sure game is paused so we can see the popup if hit from a keybind in-game

		UiToolkitAPI.ShowGenericPopupTwoOptionsBgStyle(
			$.Localize('#Action_Quit'),
			$.Localize('#Action_Quit_Message'),
			'warning-popup',
			$.Localize('#Action_Quit'),
			this.quitGame,
			$.Localize('#Action_Return'),
			() => {},
			'blur'
		);
	}

	/** Quits the game. Bye! */
	quitGame() {
		GameInterfaceAPI.ConsoleCommand('quit');
	}

	onEscapeKeyPressed() {
		// If the background selector is open, close that first.
		const sel = $('#BackgroundSelector');
		if (sel?.HasClass('bgselector--open')) {
			this.closeBackgroundSelector();
			return;
		}

		// Resume game in pause menu mode, OTHERWISE close the active menu menu page
		if (GameInterfaceAPI.GetGameUIState() === GameUIState.PAUSEMENU) {
			$.DispatchEvent('MainMenuResumeGame');
		} else {
			this.hideMainMenuPageContent();
		}
	}

	onAuthenticated(result: MomentumAPI.AuthenicationResult) {
		if (result === MomentumAPI.AuthenicationResult.SUCCESS) {
			const handle = $.RegisterForUnhandledEvent('MomAPI_LocalUserUpdate', (user) => {
				if ((user.roles & Role.LIMITED) !== 0) {
					UiToolkitAPI.ShowGenericPopupTwoOptions(
						'#API_Auth_LimitedSteamAccount',
						'#API_Auth_LimitedSteamAccount_Info',
						'wide-popup',
						'#API_Auth_LimitedSteamAccount_Link',
						() => SteamOverlayAPI.OpenURL('https://help.steampowered.com/en/faqs/view/71D3-35C2-AD96-AA3A'),
						'#Common_OK',
						() => {}
					);
				}

				$.UnregisterForUnhandledEvent('MomAPI_LocalUserUpdate', handle);
			});

			return;
		}

		let token: string;
		switch (result) {
			case AuthenicationResult.FAILURE_LOCAL_STEAM_CONNECTION:
			case AuthenicationResult.FAILURE_BACKEND_STEAM_CONNECTION:
				token = '#API_Auth_SteamDown';
				break;
			case AuthenicationResult.FAILURE_SIGNUPS_DISABLED:
				token = '#API_Auth_SignupsDisabled';
				break;
			case AuthenicationResult.FAILURE_BACKEND_DOWN:
				token = '#API_Auth_BackendDown';
				break;
			default:
				token = '#API_Auth_Unauthorized';
		}

		UiToolkitAPI.ShowGenericPopupOk('#API_Auth_Failure', token, 'wide-popup', () => {});
	}

	checkUserLegalConsent(): Promise<void> {
		return new Promise((resolve) => {
			const consent = MomentumAPI.GetUserAuthConsent();
			if (consent === MomentumAPI.UserAuthConsent.VALID) {
				resolve();
				return;
			}

			this.toggleAnnounceMode(true);
			this.panels.legal.LoadLayoutSnippet(
				consent === MomentumAPI.UserAuthConsent.INVALID ? 'UserConsentInitial' : 'UserConsentOutdated'
			);

			this.panels.legal.FindChildTraverse('OKButton')!.SetPanelEvent('onactivate', () => {
				MomentumAPI.GrantUserAuthConsent();
				this.toggleAnnounceMode(false);
				resolve();
			});

			this.panels.legal.FindChildTraverse('DeclineButton')!.SetPanelEvent('onactivate', () => {
				GameInterfaceAPI.ConsoleCommand('quit');
			});
		});
	}

	/**
	 * Put the main menu into "announce" mode, when we want to show
	 * big fullscreen stuff on startup like legal consent
	 */
	toggleAnnounceMode(enable: boolean) {
		this.panels.cp.SetHasClass('--announce-mode', enable);
	}
}
