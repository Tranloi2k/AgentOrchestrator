/**
 * Server entry: HTTP + WebSocket, wired from each feature's own routes.
 */
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import http from "node:http";
import { DEFAULT_CWD } from "./core/config.js";
import { HOST, ALLOWED_ORIGINS, ALLOWED_ROOTS, isLoopbackHost, requestGuard, verifyWsClient } from "./core/security.js";
import { subscribe } from "./features/runs/run-store.js";
import { startScheduler } from "./features/schedules/scheduler.js";
import * as meta from "./features/meta/meta.routes.js";
import * as workspace from "./features/workspace/workspace.routes.js";
import * as agents from "./features/agents/agents.routes.js";
import * as skills from "./features/skills/skills.routes.js";
import * as plugins from "./features/plugins/plugins.routes.js";
import * as workflows from "./features/workflows/workflows.routes.js";
import * as runs from "./features/runs/runs.routes.js";
import * as bridge from "./features/bridge/bridge.routes.js";
import * as schedules from "./features/schedules/schedules.routes.js";

const PORT = process.env.PORT || 5175;

const app = express();
app.use(requestGuard);
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

for (const feature of [meta, workspace, agents, skills, plugins, workflows, runs, bridge, schedules]) feature.register(app);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", verifyClient: verifyWsClient });

// Every run/task event goes out to every connected browser.
wss.on("connection", (ws) => {
  const unsubscribe = subscribe((event) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  });
  ws.on("close", unsubscribe);
});

server.listen(PORT, HOST, () => {
  startScheduler();
  console.log(`[orchestrator] server listening on http://${HOST}:${PORT}`);
  console.log(`[orchestrator] default target dir: ${DEFAULT_CWD}`);
  console.log(`[orchestrator] allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  if (ALLOWED_ROOTS.length) console.log(`[orchestrator] allowed roots: ${ALLOWED_ROOTS.join(", ")}`);
  if (!isLoopbackHost(HOST)) {
    console.warn(`[orchestrator] WARNING: HOST=${HOST} is not loopback — the port is open to other machines (requests whose Host isn't localhost are still refused).`);
  }
});
