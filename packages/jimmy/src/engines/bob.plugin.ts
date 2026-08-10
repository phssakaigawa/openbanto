// IBM Bob — the FIRST OpenBanto engine expressed as an engine plugin.
//
// This thin wrapper is what every engine will eventually look like: a
// `defineEnginePlugin({ name, capabilities, defaultBin, create })` object that
// declares what the engine can do (so the core reads capabilities instead of
// `engine === "bob"`) and lazily constructs the engine class inside create().
//
// It uses the core's local `defineEnginePlugin` (structurally identical to
// @openbanto/engine-sdk's, so an external Bob-style plugin would be assignable)
// and dynamic-imports BobEngine so the class is only loaded when Bob is actually
// configured. See docs/design/engine-plugins.md and the BANTO-PORT-PLAN.
import { defineEnginePlugin, CAPABILITIES } from "./registry.js";

export default defineEnginePlugin({
  name: "bob",
  capabilities: CAPABILITIES.bob,
  defaultBin: "bob",
  async create() {
    const { BobEngine } = await import("./bob.js");
    return new BobEngine();
  },
});
