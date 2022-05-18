'use strict';

const BUTTONS = {
	ATTACK: 1 << 0,
	JUMP: 1 << 1,
	DUCK: 1 << 2,
	FORWARD: 1 << 3,
	BACK: 1 << 4,
	USE: 1 << 5,
	CANCEL: 1 << 6,
	LEFT: 1 << 7,
	RIGHT: 1 << 8,
	MOVELEFT: 1 << 9,
	MOVERIGHT: 1 << 10,
	ATTACK2: 1 << 11,
	SCORE: 1 << 16,
	SPEED: 1 << 17,
	WALK: 1 << 18,
	ZOOM: 1 << 19,
	LOOKSPIN: 1 << 25,
	BHOPDISABLED: 1 << 29,
	PAINT: 1 << 30,
	STRAFE: 1 << 31
};

class Synchronizer {
	static segments = [
		$('#Segment0'),
		$('#Segment1'),
		$('#Segment2'),
		$('#Segment3'),
		$('#Segment4')
	];

	static lastSpeed = 0;
	static lastAngle = 0;
	static rad2deg = 180 / Math.PI;
	static deg2rad = 1 / this.rad2deg;
	static bIsFirstPanelColored = true;
	static maxSegmentWidth = 25; // percentage of total element width
	static firstPanelWidth = 25;

	static onLoad() {
		this.maxSpeed = 30; // bhop max air speed
		this.maxAccel = 30; // 1000 air accel caps to this value
		this.syncGain = 1; // scale how fast the bars move
	}

	static onUpdate() {
		const speed = this.getSize(MomentumPlayerAPI.GetVelocity());
		//const fastAngle = this.findFastAngle(speed, this.maxSpeed, this.maxAccel);
		const viewAngle = MomentumPlayerAPI.GetAngles().y;
		
		const nextVelocity = {
			x: speed,// + this.maxAccel * Math.cos(fastAngle),
			y: this.maxAccel// * Math.sin(fastAngle)
		}

		const allButtons = MomentumInputAPI.GetButtons().buttons;
		const sign = (allButtons & BUTTONS.MOVERIGHT ? 1 : 0) - (allButtons & BUTTONS.MOVELEFT ? 1 : 0);

		const idealRate = Math.atan2(nextVelocity.y, nextVelocity.x) * this.rad2deg;
		const angleDelta = this.lastAngle - viewAngle;
		this.lastAngle = viewAngle;

		this.firstPanelWidth += this.syncGain * (sign * idealRate - angleDelta); //this.modulo(this.firstPanelWidth + 2, this.maxSegmentWidth, this.bIsFirstPanelColored);

		while (this.firstPanelWidth > this.maxSegmentWidth) {
			this.firstPanelWidth -= this.maxSegmentWidth;
			this.bIsFirstPanelColored = !this.bIsFirstPanelColored;
		}
		while (this.firstPanelWidth < 0) {
			this.firstPanelWidth += this.maxSegmentWidth;
			this.bIsFirstPanelColored = !this.bIsFirstPanelColored;
		}

		this.segments[0].style.width = (isNaN(this.firstPanelWidth) ? this.maxSegmentWidth : this.firstPanelWidth) + '%';

		this.segments.forEach((segment, i) => {
			let index = i + (this.bIsFirstPanelColored ? 1 : 0);
			segment.style.backgroundColor = index % 2 ? '#FFFFFFFF' : '#FFFFFF00'; // could be colored by strafe effectiveness
			// makes sense to place colors in config.scss and apply color classes here
		});
	}
	/*
	static findFastAngle(dropSpeed, maxSpeed, maxAccel) {
		const threshold = maxSpeed - maxAccel;
		return Math.acos(dropSpeed < threshold ? 1 : threshold / dropSpeed);
	}
	*/
	static getSize(vec) {
		return Math.sqrt(this.getSizeSquared(vec));
	}

	static getSizeSquared(vec) {
		return vec.x * vec.x + vec.y * vec.y;
	}

	static {
		$.RegisterEventHandler('ChaosHudProcessInput', $.GetContextPanel(), this.onUpdate.bind(this));

		$.RegisterForUnhandledEvent('ChaosLevelInitPostEntity', this.onLoad.bind(this));
	}
}
