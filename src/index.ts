/**
 * arena — where the monkeys fight.
 *
 * The army's test harness. Simian and gorilla are pure decision engines; the
 * arena is the place a *system under test* enters and is run through
 * randomized fault trials. Each trial:
 *
 *   - draws a fresh seed (generative: SEED=$RANDOM explores the weirdest
 *     fault surfaces; the failing trial's seed is attached for CI replay),
 *   - applies simian kill decisions (some targets are "down"),
 *   - 15% of trials add a gorilla whole-cell outage,
 *   - runs the SUT and requires its invariant to hold anyway.
 *
 * This is the estate's "hypothesize, inject, measure" loop in test form: the
 * SUT's invariant IS the steady-state hypothesis.
 */
import { chaosMonkeyPass, mulberry32, type ChaosMonkeyConfig, type DamageReport } from "@army/simian";
import { chooseCell, type CellTopology } from "@army/gorilla";

export interface TrialContext {
	/** Seed of this trial (reproduce with SEED=<seed>). */
	seed: number;
	/** Simian damage report — which targets the monkey chose to kill. */
	report: DamageReport;
	/** Targets "down" this trial (kills ∪ whole-cell members). */
	down: string[];
	/** True when a whole cell was taken out this trial (gorilla). */
	cellOut: boolean;
	/** The cell that went dark, when cellOut. */
	cellId?: string;
}

export interface ArenaOptions {
	/** Randomized trials (default 12). */
	trials?: number;
	/** Targets the monkey may terminate. */
	targets?: readonly string[];
	/** Per-trial termination probability (default 0.25). */
	probability?: number;
	/** Never terminate these (default keeps the coordinator up). */
	protect?: readonly string[];
	/** Cell topology for gorilla whole-cell trials. */
	cells?: CellTopology;
	/** Seed; defaults to SEED env or time. */
	seed?: number;
	/** Chance of a gorilla cell-out per trial (default 0.15). */
	cellOutChance?: number;
}

/**
 * Run `fn` through randomized fault trials. The callback receives a
 * TrialContext describing what is down and must keep its invariant true.
 * First failing trial throws with the seed + down-set attached.
 */
export async function runArena(
	fn: (ctx: TrialContext) => Promise<void> | void,
	options: ArenaOptions = {},
): Promise<void> {
	const trials = options.trials ?? 12;
	const targets = options.targets ?? ["gw-1", "gw-2", "gw-3", "db", "cache", "worker"];
	const protect = options.protect ?? ["coordinator"];
	const probability = options.probability ?? 0.25;
	const cellOutChance = options.cellOutChance ?? 0.15;
	const baseSeed = options.seed ?? Number(process.env.SEED ?? Date.now());

	for (let i = 0; i < trials; i++) {
		const seed = (baseSeed + i * 7919) >>> 0;
		const cfg: ChaosMonkeyConfig = { probability, hardKillChance: 0.5, protect };
		const report = chaosMonkeyPass([...targets], cfg, { rng: mulberry32(seed) });

		let cellOut = false;
		let cellId: string | undefined;
		let down = report.killed.map(k => k.target.id);
		if (options.cells !== undefined && mulberry32(seed + 1)() < cellOutChance) {
			const cell = chooseCell(options.cells, mulberry32(seed + 2));
			cellId = cell.id;
			cellOut = true;
			down = [...new Set([...down, ...cell.members])];
		}

		const ctx: TrialContext = { seed, report, down, cellOut, cellId };
		try {
			await fn(ctx);
		} catch (err) {
			const e = err as Error;
			e.message = `[arena trial ${i + 1}/${trials} seed=${seed} down=${down.join(",")}${cellId ? ` cell=${cellId}` : ""}] ${e.message}`;
			throw e;
		}
	}
}

/** Is this target (or cell member) down in this trial? */
export function isDown(ctx: TrialContext, id: string): boolean {
	return ctx.down.includes(id);
}

/** The first down target, or undefined if the monkey rested. */
export function firstDown(ctx: TrialContext): string | undefined {
	return ctx.down[0];
}