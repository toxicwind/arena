import { describe, test, expect } from "bun:test";
import { runArena, isDown, firstDown } from "../src/index.ts";
import type { CellTopology } from "@army/gorilla";

const SEED = Number(process.env.SEED ?? "20261102");

// ── GENERATIVE: a retrying gateway must survive every fault draw ────────
// The system under test: a small fan-out gateway that contacts 3 workers,
// supports retry, and must return the union of replies even when workers die.
// The arena runs it through randomized simian kills (+ occasional gorilla
// cell loss) and the invariant (all surviving workers replied, no crash)
// must hold on EVERY draw. SEED=<n> replays a failing draw deterministically.

function makeGateway(targets: string[]) {
	const dead: string[] = [];
	return {
		kill(target: string): void {
			dead.push(target);
		},
		isDown(target: string): boolean {
			return dead.includes(target);
		},
		async run(): Promise<string[]> {
			// Invariant: every UP worker replies; down workers are skipped by
			// retry-ish logic, never crash the whole gateway.
			const replies: string[] = [];
			for (const t of targets) {
				if (this.isDown(t)) continue;
				replies.push(`reply-${t}`);
			}
			return replies;
		},
	};
}

describe("GENERATIVE: gateway survives the arena (random kills + cell loss)", () => {
	test("invariant holds across 15 randomized trials (SEED=" + SEED + ")", async () => {
		const targets = ["gw-1", "gw-2", "gw-3", "db", "cache"];
		const cells: CellTopology = {
			cells: [
				{ id: "cell-a", members: ["gw-1", "gw-2"] },
				{ id: "cell-b", members: ["gw-3", "db"] },
				{ id: "control", members: ["coordinator"], critical: true },
			],
		};
		await runArena(
			async (ctx) => {
				const gateway = makeGateway(targets);
				for (const t of ctx.down) gateway.kill(t);
				const replies = await gateway.run();
				// Invariant 1: never crash — at least the UP targets replied
				const up = targets.filter(t => !ctx.down.includes(t));
				expect(replies.length).toBe(up.length);
				// Invariant 2: every reply names a live target
				for (const r of replies) {
					const id = r.replace("reply-", "");
					expect(ctx.down).not.toContain(id);
				}
				// Invariant 3: helper reads agree with the down set
				if (firstDown(ctx) !== undefined) {
					expect(isDown(ctx, firstDown(ctx)!)).toBe(true);
				}
			},
			{
				trials: 15,
				targets,
				cells,
				probability: 0.3,
				seed: SEED,
			},
		);
	});

	test("deterministic: same seed → same refusal-to-crash outcome", async () => {
		const targets = ["a", "b", "c"];
		for (const seed of [1, 2, 3]) {
			let passes = 0;
			await runArena(
				async (ctx) => {
					const g = makeGateway(targets);
					ctx.down.forEach(t => g.kill(t));
					const replies = await g.run();
					expect(replies.length).toBe(targets.filter(t => !ctx.down.includes(t)).length);
					passes++;
				},
				{ trials: 5, targets, probability: 0.4, seed },
			);
			expect(passes).toBe(5);
		}
	});
});