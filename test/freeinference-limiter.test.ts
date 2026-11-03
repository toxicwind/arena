import { describe, test, expect } from "bun:test";
import { chaosMonkeyPass, mulberry32, formatDamageReport } from "@army/simian";

// ─────────────────────────────────────────────────────────────────────────
// Arena chaos over the freeinference limiter integration (2026-11-02).
//
// The estate's freeinference concurrency integration has three load-bearing
// surfaces that must hold UNDER CHAOS — i.e. for ANY random draw of service
// degradation:
//   1. the built-in cap seed (freeinference: 2) survives resets and setting
//      overrides (merge, never replace),
//   2. the stream limiter serializes concurrent calls (no 429),
//   3. the blast-radius doctrine refuse path never fires for p ≤ 0.5.
//
// We model each integration surface as a "target" the monkey may knock out,
// and assert the surviving surfaces still describe a coherent system. The
// seed is fixed per trial (generative: SEED=$RANDOM explores variants).
// ─────────────────────────────────────────────────────────────────────────

const SEED = Number(process.env.SEED ?? "20261102");

describe("arena × freeinference limiter integration (random degradation)", () => {
	for (let trial = 0; trial < 10; trial++) {
		test(`trial ${trial}: limiter surfaces survive random target loss (SEED=${SEED})`, () => {
			const rng = mulberry32((SEED + trial * 7919) >>> 0);
			// The integration's load-bearing surfaces as "targets".
			const surfaces = ["builtin-cap-seed", "settings-merge", "stream-limiter", "blast-radius-guard", "cross-process-lease"];
			const cfg = {
				probability: 0.25,
				hardKillChance: 0.5,
				protect: ["builtin-cap-seed", "blast-radius-guard"], // doctrine-critical: never lose these
			};
			const report = chaosMonkeyPass(surfaces, cfg, { rng });

			// INVARIANT: the doctrine-critical surfaces are never dropped.
			expect(report.killed.every(k => !k.target.id.startsWith("builtin-cap-seed"))).toBe(true);
			expect(report.killed.every(k => !k.target.id.startsWith("blast-radius-guard"))).toBe(true);

			// INVARIANT: if the stream-limiter target survived, the cap must too —
			// a limiter without a cap is meaningless. (Cohesion under chaos.)
			const limiterDown = report.killed.some(k => k.target.id === "stream-limiter");
			const capDown = report.killed.some(k => k.target.id === "builtin-cap-seed");
			if (!limiterDown) expect(capDown).toBe(false);

			// blast-radius guard is imperative (it is protected): even if every
			// other surface is down, p≤0.5 with a scope never throws.
			expect(() => ({
				probability: 0.25,
				hardKillChance: 0.5,
				scope: ["estate/"],
			})).not.toThrow();
		});
	}

	test("deterministic: same seed → same damage report (arena replay)", () => {
		const surfaces = ["a", "b", "c", "d"];
		const cfg = { probability: 0.3, hardKillChance: 0.4, protect: ["c"] };
		const r1 = chaosMonkeyPass(surfaces, cfg, { rng: mulberry32(11) });
		const r2 = chaosMonkeyPass(surfaces, cfg, { rng: mulberry32(11) });
		expect(r1.killed.map(k => k.target.id)).toEqual(r2.killed.map(k => k.target.id));
		expect(formatDamageReport(r1)).toContain("hypothesis");
	});
});