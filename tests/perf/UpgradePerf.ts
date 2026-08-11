import Benchmark from "benchmark";
import path from "path";
import { fileURLToPath } from "url";
import { GameRunner } from "../../src/core/GameRunner";
import { Executor } from "../../src/core/execution/ExecutionManager";
import {
  BuildableUnit,
  Game,
  Gold,
  Player,
  PlayerInfo,
  PlayerType,
  STRUCTURE_BULK_STEPS,
  Structures,
  UnitType,
  bulkCost,
  maxBulkAmount,
} from "../../src/core/game/Game";
import { setup } from "../util/Setup";

const TEST_UTIL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "util",
);

const UPGRADABLE = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
];

async function buildScenario(): Promise<{
  game: Game;
  player: Player;
  runner: GameRunner;
}> {
  const game = await setup(
    "half_land_half_ocean",
    { instantBuild: true },
    [new PlayerInfo("perf", PlayerType.Human, null, "perf")],
    TEST_UTIL_DIR,
  );
  const player = game.player("perf");
  game.config().structureMinDist = () => 2;
  player.addGold(1_000_000_000n);

  for (let y = 0; y < game.height(); y++) {
    for (let x = 0; x < game.width(); x++) {
      const t = game.ref(x, y);
      if (game.isLand(t)) {
        player.conquer(t);
      }
    }
  }

  const cluster: [UnitType, number, number][] = [
    [UnitType.City, 5, 8],
    [UnitType.Port, 7, 8],
    [UnitType.Factory, 6, 7],
    [UnitType.SAMLauncher, 6, 9],
    [UnitType.MissileSilo, 5, 7],
    [UnitType.DefensePost, 7, 7],
  ];
  for (const [type, x, y] of cluster) {
    player.buildUnit(type, game.ref(x, y), {});
  }

  // Scatter extra upgradable structures away from the cluster so the
  // unitsOwned() scans inside costWrapper are non-trivial.
  const extrasPerType = 20;
  let k = 0;
  outer: for (let y = 0; y < game.height(); y++) {
    for (let x = 0; x < 8; x++) {
      if (Math.abs(x - 6) <= 3 && Math.abs(y - 8) <= 3) continue;
      player.buildUnit(UPGRADABLE[k % UPGRADABLE.length], game.ref(x, y), {});
      k++;
      if (k >= extrasPerType * UPGRADABLE.length) break outer;
    }
  }

  const runner = new GameRunner(
    game,
    new Executor(game, "perf_game", undefined),
    () => {},
  );

  // Self-check: the hover drives every upgradable upgrade loop, and the menu
  // produces bulk slots for each of them.
  const hovered = runner.playerActions("perf", 6, 8, Structures.types);
  const seen = new Set<UnitType>();
  for (const bu of hovered.buildableUnits) {
    if (bu.canUpgrade === false) {
      continue;
    }
    if (bu.upgradeCosts === undefined) {
      throw new Error(`${bu.type}: canUpgrade set but upgradeCosts missing`);
    }
    const max = maxBulkAmount(bu, player.gold());
    if (max <= 1) {
      throw new Error(`${bu.type}: menu produced no bulk slots`);
    }
    seen.add(bu.type);
  }
  const missing = UPGRADABLE.filter((t) => !seen.has(t));
  if (missing.length > 0) {
    throw new Error(
      `upgrade loop did not run for: ${missing.join(", ")} — ` +
        "is the scenario placing upgradable structures near the hover tile?",
    );
  }

  return { game, player, runner };
}

function priceMenuSlots(buildables: BuildableUnit[], gold: Gold): void {
  for (const bu of buildables) {
    const maxAmount = maxBulkAmount(bu, gold);
    if (maxAmount <= 1) {
      continue;
    }
    for (const amount of [1, ...STRUCTURE_BULK_STEPS, maxAmount]) {
      bulkCost(bu, amount);
    }
  }
}

async function main(): Promise<void> {
  const { player, runner } = await buildScenario();
  const gold = player.gold();
  const unitCount = player.units().length;

  const results: string[] = [];
  const suite = new Benchmark.Suite()
    .add(
      `playerActions hover (${unitCount} units, 5 upgradable types)`,
      () => {
        runner.playerActions("perf", 6, 8, Structures.types);
      },
      { minSamples: 200 },
    )
    .add(
      `hover + bulk menu pricing (maxBulkAmount/bulkCost)`,
      () => {
        const hovered = runner.playerActions("perf", 6, 8, Structures.types);
        priceMenuSlots(hovered.buildableUnits, gold);
      },
      { minSamples: 200 },
    )
    .on("cycle", (event: Benchmark.Event) => {
      results.push(String(event.target));
    })
    .on("complete", function (this: Benchmark.Suite) {
      console.log("\n=== UpgradeRealUsePerf Benchmark Results ===");
      for (const result of results) {
        console.log(result);
      }
    });

  suite.run({ async: false });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
