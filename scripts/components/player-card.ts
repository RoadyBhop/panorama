import { OnPanelLoad, PanelHandler } from 'util/module-helpers';
import { User } from 'common/web/types/models/models';

@PanelHandler({ exposeToPanel: true })
export class PlayerCardHandler implements OnPanelLoad {
	readonly panels = {
		cp: $.GetContextPanel<PlayerCard>(),
		progressBar: $<ProgressBar>('#XpProgressBar'),
		levelIndicator: $<LevelIndicator>('#LevelIndicator')
	};

	onPanelLoad() {
		this.update();
		$.RegisterForUnhandledEvent('MomAPI_LocalUserUpdate', (_user: User) => this.update());
	}

	update() {
		const level = MomentumAPI.GetPlayerLevel();
		const xp = MomentumAPI.GetPlayerXp();

		const rawCurrLevelXp = MomentumAPI.GetCosmeticXpForLevel(level);
		const rawNextLevelXp = MomentumAPI.GetCosmeticXpForLevel(level + 1);

		const money = MomentumAPI.GetPlayerMoney();

		// Make sure the XP thresholds are valid.
		const currLevelXp = Math.max(0, rawCurrLevelXp);
		const nextLevelXp = rawNextLevelXp > currLevelXp
			? rawNextLevelXp
			: currLevelXp + 1;

		// Clamp XP so it can never overflow the current level.
		const safeXp = Math.min(
			Math.max(xp, currLevelXp),
			nextLevelXp
		);

		const currentLevelXp = safeXp - currLevelXp;
		const totalLevelXp = nextLevelXp - currLevelXp;

		// Set the dialog variables so this can be used in labels.
		this.panels.cp.SetDialogVariable('name', FriendsAPI.GetLocalPlayerName());
		this.panels.cp.SetDialogVariableInt('level', level);
		this.panels.cp.SetDialogVariableInt('xp', currentLevelXp);
		this.panels.cp.SetDialogVariableInt('totalxp', totalLevelXp);
		this.panels.cp.SetDialogVariableInt('money', 69420);

		// Update the progress bar.
		this.panels.progressBar.value = safeXp;
		this.panels.progressBar.min = currLevelXp;
		this.panels.progressBar.max = nextLevelXp;

		this.panels.levelIndicator.handler.setLevel(level);
	}
}