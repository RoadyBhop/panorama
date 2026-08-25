import { PanelHandler } from 'util/module-helpers';
import {
	GroupedLobbyLists,
	Lobby,
	LobbyList,
	LobbyMemberStateChange,
	LobbyProperties,
	LobbyType
} from 'common/online';

// Which of the three lobby lists a row came from.
type Origin = 'current' | 'friends' | 'global';
const ORIGINS: Origin[] = ['current', 'friends', 'global'];
const ORIGIN_LABEL: Record<Origin, string> = { current: 'Yours', friends: 'Friends', global: 'Global' };

// One list row: a lobby resolved for display.
interface LobbyRow {
	id: string; // steam lobby id (the key you pass to SteamLobbyAPI.Join)
	name: string;
	typeText: string;
	origin: Origin;
	members: number;
	limit: number;
	isMapLobby: boolean;
}

// Column layout — shared between the header and every row so they line up (mirrors the CS:S map selector).
const COLS: { label: string; width: string; align: 'left' | 'right' }[] = [
	{ label: 'Lobby', width: 'width: fill-parent-flow(1);', align: 'left' },
	{ label: 'Type', width: 'width: 160px;', align: 'left' },
	{ label: 'Source', width: 'width: 110px;', align: 'left' },
	{ label: 'Players', width: 'width: 90px;', align: 'right' }
];

@PanelHandler()
class CssLobbyListHandler {
	// Our own copy of the lobby lists, accumulated from the global SteamLobby events (the drawer's
	// LobbyHandler lives in a separate JS context, but these events are broadcast to every context).
	lobbyListData: GroupedLobbyLists = {};
	selectedLobbyId: string | null = null;
	loaded = false; // becomes true once we've had at least one list update

	constructor() {
		// friends / global lists (arrive after a RefreshList request).
		$.RegisterForUnhandledEvent('PanoramaComponent_SteamLobby_OnListUpdated', (lobbyList) =>
			this.onListUpdated(lobbyList)
		);
		// Our current lobby (arrives automatically while we're in one).
		$.RegisterForUnhandledEvent('PanoramaComponent_SteamLobby_OnDataUpdated', (lobbyData) =>
			this.onCurrentUpdated(lobbyData)
		);
		// Leaving a lobby clears the "current" list.
		$.RegisterForUnhandledEvent('PanoramaComponent_SteamLobby_OnLobbyStateChanged', (change) => {
			if (change === LobbyMemberStateChange.LEAVE) {
				delete this.lobbyListData.current;
				this.renderList();
			} else {
				// Joined a lobby — reflect it in the list.
				this.renderList();
			}
		});

		// Refresh whenever the page is shown so the browser is up to date.
		$.RegisterForUnhandledEvent('MainMenuPageShown', (page: string) => {
			if (page === 'CssLobbyList') this.requestRefresh();
		});
	}

	/** Fires once the page is actually shown (the root panel's onload). */
	onLoad() {
		this.renderHead();
		this.renderList();
		this.requestRefresh();
	}

	//#region data

	onListUpdated(lobbyList: GroupedLobbyLists) {
		if (!lobbyList) return;
		// C++ sends either the friends or the global list here.
		const origin = Object.keys(lobbyList)[0] as 'friends' | 'global';
		this.lobbyListData[origin] = lobbyList[origin];
		this.loaded = true;
		this.renderList();
	}

	onCurrentUpdated(lobbyData: LobbyList) {
		if (!lobbyData) return;
		this.lobbyListData.current = lobbyData;
		this.loaded = true;
		this.renderList();
	}

	/** Ask C++ for a fresh friends/global list. No-op (returns false) while on cooldown. */
	requestRefresh() {
		this.setStatus(this.loaded ? '' : 'Loading lobbies…');
		try {
			SteamLobbyAPI.RefreshList({});
		} catch {
			/* ignore */
		}
	}

	/** Build the display rows from every list, de-duped by lobby id and sorted by player count. */
	computeRows(): LobbyRow[] {
		const rows: LobbyRow[] = [];
		const seen = new Set<string>();

		for (const origin of ORIGINS) {
			const list = this.lobbyListData[origin];
			if (!list) continue;
			for (const [id, lobby] of Object.entries(list)) {
				if (seen.has(id)) continue;
				seen.add(id);
				const isMapLobby = lobby.is_map_lobby === 1;
				rows.push({
					id,
					name: this.getLobbyName(lobby.owner, isMapLobby),
					typeText: this.getTypeText(lobby.type, isMapLobby),
					origin,
					members: lobby.members,
					limit: lobby.members_limit,
					isMapLobby
				});
			}
		}

		rows.sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
		return rows;
	}

	//#endregion
	//#region rendering

	renderHead() {
		const head = $<Panel>('#CssLobbiesHead');
		if (!head) return;
		head.RemoveAndDeleteChildren();
		for (const col of COLS) {
			const cell = $.CreatePanel('Panel', head, '', { class: 'csslobbies__head-cell', style: col.width });
			$.CreatePanel('Label', cell, '', {
				class: 'csslobbies__head-text',
				text: col.label,
				style: col.align === 'right' ? 'text-align: right;' : ''
			});
		}
	}

	renderList() {
		const list = $<Panel>('#CssLobbiesList');
		if (!list) return;
		list.RemoveAndDeleteChildren();

		const rows = this.computeRows();

		const count = $<Label>('#CssLobbiesCount');
		if (count) count.text = `${rows.length} lobb${rows.length === 1 ? 'y' : 'ies'}`;

		const status = $<Label>('#CssLobbiesStatus');
		if (status) {
			if (!this.loaded) {
				status.visible = true;
				status.text = 'Loading lobbies…';
			} else if (rows.length === 0) {
				status.visible = true;
				status.text = 'No lobbies found. Press Refresh, or Create one to get started.';
			} else {
				status.visible = false;
			}
		}

		// Drop the selection if the previously-selected lobby is gone.
		if (this.selectedLobbyId != null && !rows.some((r) => r.id === this.selectedLobbyId)) {
			this.selectedLobbyId = null;
		}
		this.updateJoinButton();

		rows.forEach((row, i) => this.makeRow(list, row, i));
	}

	makeRow(list: Panel, row: LobbyRow, index: number) {
		const rowPanel = $.CreatePanel('Panel', list, `CssLobbyRow${row.id}`, {
			class: 'csslobbies__row' + (index % 2 === 1 ? ' csslobbies__row--odd' : '')
		});
		if (row.id === this.selectedLobbyId) rowPanel.AddClass('csslobbies__row--selected');
		rowPanel.SetPanelEvent('onactivate', () => this.selectLobby(row.id));
		rowPanel.SetPanelEvent('ondblclick', () => {
			this.selectLobby(row.id);
			this.join();
		});

		const cellText = (text: string, col: (typeof COLS)[number], extraClass = '') => {
			const cell = $.CreatePanel('Panel', rowPanel, '', { class: 'csslobbies__cell', style: col.width });
			$.CreatePanel('Label', cell, '', {
				class: 'csslobbies__cell-text' + (extraClass ? ' ' + extraClass : ''),
				text,
				style: col.align === 'right' ? 'text-align: right;' : ''
			});
		};

		cellText(row.name, COLS[0], row.isMapLobby ? 'csslobbies__cell-text--map' : '');
		cellText(row.typeText, COLS[1]);
		cellText(ORIGIN_LABEL[row.origin], COLS[2]);
		cellText(`${row.members}/${row.limit}`, COLS[3]);
	}

	//#endregion
	//#region interaction

	selectLobby(id: string) {
		if (this.selectedLobbyId === id) return;
		const prev = this.selectedLobbyId;
		this.selectedLobbyId = id;
		if (prev != null) $<Panel>(`#CssLobbyRow${prev}`)?.RemoveClass('csslobbies__row--selected');
		$<Panel>(`#CssLobbyRow${id}`)?.AddClass('csslobbies__row--selected');
		this.updateJoinButton();
	}

	updateJoinButton() {
		const btn = $<Button>('#CssLobbiesJoin');
		// Disable when nothing's selected, or when the selection is the lobby we're already in.
		if (btn) btn.enabled = this.selectedLobbyId != null && this.selectedLobbyId !== this.currentLobbyId();
	}

	/** Join the selected lobby, warning first if it means leaving our current one (mirrors the drawer). */
	join() {
		const id = this.selectedLobbyId;
		if (id == null || id === this.currentLobbyId()) return;

		if (this.isInLobby()) {
			const message =
				this.isLobbyOwner() && this.currentMemberCount() > 1
					? $.Localize('#Lobby_TransferWarning')
					: $.Localize('#Lobby_LeaveWarning');
			UiToolkitAPI.ShowGenericPopupOkCancel(
				$.Localize('#Lobby_Leave'),
				message,
				'ok-cancel-popup',
				() => {
					SteamLobbyAPI.Leave();
					SteamLobbyAPI.Join(id);
				},
				() => {}
			);
		} else {
			SteamLobbyAPI.Join(id);
		}
	}

	/** Refresh button — request a fresh friends/global list. */
	refresh() {
		this.requestRefresh();
	}

	/** Create button — open the same lobby-create popup the drawer uses. */
	create() {
		UiToolkitAPI.ShowCustomLayoutPopupParameters(
			'',
			'file://{resources}/layout/modals/popups/lobby-create.xml',
			'isinlobby=' + +this.isInLobby() + '&islobbyowner=' + +this.isLobbyOwner()
		);
	}

	/** Close (title-bar X) — return to the CS:S menu. Cross-context, so via a global event. */
	close() {
		$.DispatchEvent('MainMenu_ClosePage');
	}

	//#endregion
	//#region current-lobby helpers

	currentLobby(): Lobby | undefined {
		return Object.values(this.lobbyListData.current ?? {})[0];
	}

	currentLobbyId(): string | null {
		return Object.keys(this.lobbyListData.current ?? {})[0] ?? null;
	}

	isInLobby(): boolean {
		return this.currentLobby() != null;
	}

	isLobbyOwner(): boolean {
		const lobby = this.currentLobby();
		return lobby != null && lobby.owner === UserAPI.GetXUID();
	}

	currentMemberCount(): number {
		return this.currentLobby()?.members ?? 0;
	}

	//#endregion

	setStatus(text: string) {
		const status = $<Label>('#CssLobbiesStatus');
		if (!status) return;
		status.visible = text !== '';
		status.text = text;
	}

	/** Lobby display name (owner name, or "Map Lobby" for map lobbies). Mirrors the drawer's getLobbyName. */
	getLobbyName(owner: steamID, isMapLobby: boolean): string {
		if (isMapLobby) {
			const map = MapCacheAPI.GetMapName();
			return map ? `${$.Localize('#Lobby_MapLobby')} (${map})` : $.Localize('#Lobby_MapLobby');
		}
		return $.Localize('#Lobby_Owner').replace('%owner%', FriendsAPI.GetNameForXUID(owner));
	}

	/** Human-readable lobby visibility. */
	getTypeText(type: LobbyType, isMapLobby: boolean): string {
		if (isMapLobby) return $.Localize('#Lobby_Type_MapLobby');
		return $.Localize(LobbyProperties.get(type)?.name ?? '') || '—';
	}
}
