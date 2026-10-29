import { MODELS, KNOWN_TOOLS, PROVIDERS, PROVIDER_AVAILABILITY, CODEX_MODELS, AGY_MODELS, DEFAULT_CWD } from "../../core/config.js";
import { ACCESS_LEVELS, accessOptions } from "../agents/access.js";

/** meta: model lists, known tools, CLI availability, access levels, default working dir. */
export function register(app) {
  app.get("/api/meta", (req, res) => {
    res.json({
      models: MODELS,
      tools: KNOWN_TOOLS,
      providers: PROVIDERS,
      providerAvailability: PROVIDER_AVAILABILITY,
      codexModels: CODEX_MODELS,
      geminiModels: AGY_MODELS,
      accessLevels: ACCESS_LEVELS,
      accessOptions: accessOptions(),
      defaultCwd: DEFAULT_CWD,
    });
  });
}
