> **Lưu ý (cấu trúc mới):** `server/orchestrator.js` không còn tồn tại. Code server giờ chia theo tính năng trong `server/src/features/` — điều phối run nằm ở `runs/executor.js`, chạy CLI ở `runs/cli-runners.js`, lịch sử run ở `runs/run-store.js`, dữ liệu agent/workflow/skill/plugin ở `<tính năng>/<tính năng>.store.js`, và `src/index.js` chỉ khởi động server rồi đăng ký route của từng tính năng. Phần dưới đây mô tả thiết kế, các đường dẫn file trong đó là của cấu trúc cũ. Xem mục "Project layout" trong README.

# Vai trò của `server/orchestrator.js`

## Tổng quan

`server/orchestrator.js` là **module lõi điều phối multi-agent** của hệ thống. Nó tách biệt hoàn toàn khỏi lớp HTTP (Express/WebSocket nằm ở `server/index.js`), chỉ việc gọi các hàm được export từ orchestrator để:
- Quản lý cấu hình agent & workflow (CRUD)
- Chạy agent đơn lẻ hoặc workflow tuần tự
- Stream log realtime qua event pub-sub
- Giữ trạng thái các lượt chạy (chỉ trong bộ nhớ)

---

## Cấu trúc chính

### 1. **Persistence: Agents** (dòng 23–87)

**Chức năng:** Quản lý danh sách agents (AI models với cấu hình riêng).

**Lưu trữ:** File `agents.config.json`

**Các phép CRUD:**
- `listAgents()` → trả về tất cả agents
- `getAgent(agentId)` → trả về agent theo ID (fallback là agent đầu tiên)
- `createAgent(input)` → thêm agent mới (gán ID nanoid)
- `updateAgent(id, input)` → cập nhật agent hiện có
- `deleteAgent(id)` → xóa agent

**Cấu trúc Agent object:**
```javascript
{
  id: string,              // nanoid(8)
  name: string,            // tên agent (max 80 ký tự)
  description: string,     // mô tả
  model: string,           // model ID ("sonnet", "opus", "fable", "haiku-4.5", hoặc "")
  readOnly: boolean,       // nếu true → permissionMode="plan" (không tool)
  permissionMode: string,  // "plan", "acceptEdits", hoặc khác
  allowedTools: string[],  // danh sách tool được phép (subset của KNOWN_TOOLS)
  disallowedTools: string[],  // danh sách tool cấm
  appendSystemPrompt: string  // system prompt thêm vào
}
```

**Danh sách tools được biết:** `KNOWN_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "NotebookEdit"]`

---

### 2. **Persistence: Workflows** (dòng 89–134)

**Chức năng:** Quản lý workflows (chuỗi bước chạy tuần tự, mỗi bước = 1 agent + 1 prompt template).

**Lưu trữ:** File `workflows.config.json`

**Các phép CRUD:**
- `listWorkflows()`, `getWorkflow(id)`, `createWorkflow(input)`, `updateWorkflow(id, input)`, `deleteWorkflow(id)`

**Cấu trúc Workflow object:**
```javascript
{
  id: string,           // nanoid(8)
  name: string,         // tên workflow (max 80 ký tự)
  description: string,  // mô tả
  steps: [              // chuỗi bước
    {
      agentId: string,           // agent chạy bước này
      promptTemplate: string      // template prompt (hỗ trợ {{prompt}} & {{previous}})
    },
    // ...
  ]
}
```

**Quy tắc promptTemplate:**
- Nếu trống, orchestrator sẽ tự xây dựng prompt dựa trên yêu cầu gốc + kết quả bước trước
- Nếu có template: thay thế `{{prompt}}` = yêu cầu gốc, `{{previous}}` = kết quả bước trước

---

### 3. **Runs & Event Bus** (dòng 136–184)

**Chức năng:** Lưu trạng thái các lượt chạy hiện tại, pub-sub event realtime.

**Lưu trữ:** In-memory (`Map`, mất khi restart server)

**Kiến trúc:**
- `runs: Map<runId, run>` → lưu từng lượt chạy
- `listeners: Set<callback>` → đăng ký listener để nhận event
- `emit(event)` → broadcast event cho tất cả listener
- `subscribe(fn)` → đăng ký listener (trả về hàm unsubscribe)

**Cấu trúc Run object:**
```javascript
{
  id: string,           // nanoid(10)
  prompt: string,       // yêu cầu gốc
  agentId: string,      // (ad-hoc run) hoặc null (workflow run)
  workflowId: string,   // (workflow run) hoặc null (ad-hoc run)
  decompose: boolean,   // có chia nhỏ hay không (ad-hoc run)
  cwd: string,          // thư mục làm việc
  status: "running" | "done" | "error",
  createdAt: number,    // timestamp
  tasks: Task[]         // danh sách task/step trong run
}
```

**Cấu trúc Task object:**
```javascript
{
  id: string,
  title: string,        // tiêu đề task
  kind: "planner" | "agent" | "workflow-step",
  status: "pending" | "running" | "done" | "error",
  log: string[],        // dòng log realtime
  resultText: string    // kết quả cuối (from Claude output)
}
```

**Các event:**
- `{ runId, type: "run-created", run: {...} }` → run mới được tạo
- `{ runId, type: "run-status", status: "...", error?: "..." }` → run kết thúc
- `{ runId, taskId, type: "task-created", task: {...} }` → task mới
- `{ runId, taskId, type: "task-status", status: "..." }` → task status thay đổi
- `{ runId, taskId, type: "log", line: "..." }` → log line mới

---

### 4. **Core: runClaude()** (dòng 187–260)

**Chức năng:** Spawn tiến trình Claude CLI, stream output JSONL realtime, parse events.

**Input:**
```javascript
{
  runId: string,           // ID lượt chạy
  taskId: string,          // ID task hiện tại
  prompt: string,          // prompt gửi tới Claude
  cwd: string,             // thư mục làm việc
  agent: AgentConfig,      // cấu hình agent
  extraArgs?: string[]     // thêm args cho claude CLI
}
```

**Output:** `Promise<{ ok: boolean, resultText: string }>`

**Luồng thực thi:**
1. Xây dựng args cho `claude -p` command:
   - `-p <prompt>`
   - `--output-format stream-json --verbose`
   - Thêm `--model`, `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--append-system-prompt` từ agent config
   
2. Spawn `cross-spawn("claude", args, { cwd })`

3. Đọc stdout JSONL (line-by-line):
   - **assistant event** → parse content blocks (text, tool_use) → log với emoji 💬/🔧
   - **result event** → lưu `resultText` → log ✅
   - **system event** → log ℹ️
   - **invalid JSON** → log dòng thô

4. Đọc stderr → log ⚠️

5. Trả về `{ ok: code === 0, resultText }`

---

### 5. **Decomposition: decomposePrompt()** (dòng 262–289)

**Chức năng:** Gọi Claude CLI ở chế độ **plan** (read-only, không tool) để tự động chia nhỏ prompt lớn.

**Input:**
```javascript
{
  runId: string,
  taskId: string,
  prompt: string,      // yêu cầu gốc
  cwd: string
}
```

**Output:** `Promise<string[]>` (mảng subtask)

**Luồng:**
1. Xây dựng `planPrompt`: hướng dẫn Claude chia nhỏ thành JSON array of strings
2. Gọi `runClaude()` với `permissionMode: "plan"`, `allowedTools: []`
3. Parse JSON array từ `resultText` (tìm `[...]` pattern, fallback to `resultText` nếu parse thất bại)
4. Validate mảng (phải là string[])
5. Trả về mảng subtask, hoặc `[prompt]` nếu parse thất bại

---

### 6. **Ad-hoc Run** (dòng 297–364)

**Chức năng:** Chạy 1 agent với 1 prompt, tuỳ chọn chia nhỏ.

**startRun():**
```javascript
async startRun({ prompt, agentId, decompose, cwd })
  → runId (string)
```
- Tạo run object mới với status="running"
- Lưu vào `runs` Map
- Emit `run-created` event
- Trigger `executeRun()` async (via `process.nextTick()`)
- Trả về `runId` ngay (không chờ thực thi)

**executeRun():**
1. Nếu `decompose=true`:
   - Tạo **planner task** (kind="planner", title="chia nhỏ yêu cầu")
   - Gọi `decomposePrompt()` → lấy mảng subtask
   - Mark planner task done

2. Chạy tuần tự từng **agent task** (kind="agent"):
   - Gọi `runClaude()` với subtask + agent
   - Lưu `resultText` vào task
   - Mark task done/error

3. Mark run done

---

### 7. **Workflow Run** (dòng 368–449)

**Chức năng:** Chạy workflow (chuỗi bước cố định, mỗi bước = agent khác nhau).

**startWorkflowRun():**
```javascript
async startWorkflowRun({ prompt, workflowId, cwd })
  → runId (string)
```
- Tạo run object mới với status="running"
- Lưu vào `runs` Map
- Emit `run-created` event
- Trigger `executeWorkflowRun()` async
- Trả về `runId` ngay

**executeWorkflowRun():**
1. Lặp tuần tự từng **step** của workflow:
   - Lấy agent cho step
   - Xây dựng prompt step bằng `buildStepPrompt()` (support {{prompt}}, {{previous}})
   - Tạo **workflow-step task**
   - Gọi `runClaude()` với step prompt + agent
   - Lưu `resultText` vào `previous` (dùng cho step kế tiếp)
   - Nếu task error → stop workflow, mark run error
   - Nếu success → tiếp tục

2. Mark run done

**buildStepPrompt():**
- Nếu template có: thay `{{prompt}}` → yêu cầu gốc, `{{previous}}` → kết quả step trước
- Nếu template rỗng + index > 0 + previous có: xây dựng auto-format:
  ```
  Yêu cầu gốc: <prompt>
  
  Kết quả từ bước trước trong workflow:
  <previous>
  
  Hãy tiếp tục thực hiện bước tiếp theo dựa trên thông tin trên.
  ```
- Nếu template rỗng + index === 0: dùng `prompt` trực tiếp

---

## Luồng dữ liệu tổng quát

### Ad-hoc Run (có decompose)
```
prompt
  ↓
startRun(prompt, agentId, decompose=true)
  ↓
Run { id, prompt, agentId, tasks: [] }  +  emit("run-created")
  ↓
executeRun()
  ├─ planner task: decomposePrompt() → [subtask1, subtask2, ...]
  │   emit("task-created", "task-status")
  │
  ├─ agent task 1: runClaude(subtask1) → resultText1
  │   emit("task-created", "task-status", "log", "task-status")
  │
  ├─ agent task 2: runClaude(subtask2) → resultText2
  │   emit(...)
  │
  └─ ... (tuần tự)
      emit("run-status" = "done")
```

### Workflow Run
```
prompt + workflowId
  ↓
startWorkflowRun(prompt, workflowId)
  ↓
Run { id, prompt, workflowId, tasks: [] }  +  emit("run-created")
  ↓
executeWorkflowRun()
  ├─ step 1 (agent A): 
  │   buildStepPrompt(template, prompt, "")
  │   runClaude(stepPrompt) → resultText1
  │   previous = resultText1
  │   emit(...)
  │
  ├─ step 2 (agent B):
  │   buildStepPrompt(template, prompt, resultText1)
  │   runClaude(stepPrompt) → resultText2
  │   previous = resultText2
  │   emit(...)
  │
  └─ ... (tuần tự)
      emit("run-status" = "done")
```

### Event Streaming
```
listener = subscribe(callback)
  ↓
emit(event)
  ↓
callback(event)  [broadcast tất cả listener]
  ↓
index.js: listener → WebSocket.send(event) → client
```

---

## Điểm đáng lưu ý

### 💾 Trạng thái chỉ trong RAM
- `runs` Map được lưu chỉ trong bộ nhớ
- Restart server → mất toàn bộ lịch sử run
- Agents & workflows được lưu vào file JSON (persistent)

### 🔄 Async + Event-driven
- `startRun()` / `startWorkflowRun()` **không chặn** (dùng `process.nextTick()`)
- Trả về `runId` ngay, thực thi bất đồng bộ
- Event pub-sub cho phép client subscribe realtime log

### 🎯 Decompose strategy
- Gọi Claude ở chế độ **plan** (read-only, model không bị giới hạn by agent config)
- Tự động chia nhỏ yêu cầu lớn thành subtask, mỗi subtask độc lập
- Fallback: nếu parse JSON thất bại → dùng prompt nguyên gốc

### 🔗 Workflow chaining
- Mỗi step của workflow nhận **prompt gốc** + **kết quả step trước**
- Hỗ trợ template với `{{prompt}}` & `{{previous}}` placeholder
- Nếu 1 step error → workflow stop (không tiếp tục step kế tiếp)

### 📊 CLI integration
- `runClaude()` spawn `claude` CLI qua `cross-spawn`
- Đọc JSONL stream từ `--output-format stream-json`
- Hỗ trợ agent config: model, permissionMode, allowedTools, disallowedTools, appendSystemPrompt

### 👥 Team: thành viên nhớ các vòng sửa của cùng một công việc
- Phía server của `ask_agent` nằm ở `runs/team-calls.js` (`createTeamCalls`). Run map, tra agent, process runner và task log được truyền vào, nên test dùng runner giả, không gọi CLI thật.
- Mỗi lần giao việc được ghi vào `run.delegations` kèm `agentId`, `provider`, `cwd` và `sessionId` mà CLI trả về; câu hỏi được lưu ở `task.question`.
- Lần gọi sau cho cùng `workItemId`, cùng node đích và cùng agent: Claude/agy mở lại phiên đó (`--resume` / `--conversation`) và chỉ nhận tin nhắn mới. Claude giữ phiên theo thư mục, nên chỉ resume khi `cwd` trùng.
- Không resume được (Codex, khác thư mục) hoặc resume thất bại: chạy tiến trình mới, kèm tóm tắt lần trước (yêu cầu + câu trả lời) đặt trước yêu cầu mới.
- `workItemId` mới, hoặc giao cho node/agent khác sau failover: luôn bắt đầu mới.
- Log của task ghi rõ trường hợp nào đã xảy ra; `task.continuation` là `resumed`, `transcript` hoặc `fresh`.

### 🔀 Team: failover giữa các agent của một thành viên
- Thành viên có `agentIds` (agent chính trước, dự phòng sau). Team cũ chỉ có `agentId` được đọc thành danh sách một phần tử. Node của thành viên giữ `agentId` = agent chính để mọi chỗ đặt tên theo agent vẫn chạy.
- Server chọn agent (`runWithFailover` trong `team-calls.js`): bỏ qua agent có CLI chưa cài (`PROVIDER_AVAILABILITY`) và provider đang bị tạm ngưng trong run (`run.providerCooldowns`).
- Agent lỗi `quota` hoặc `provider_unavailable`: provider bị tạm ngưng tới giờ reset đọc được từ thông báo lỗi (`parseQuotaReset` trong `delegation-policy.js`, hoặc `resetsAt` từ rate-limit event của Claude); không đọc được thì tới hết run. Agent tiếp theo chạy ngay trong cùng lời gọi, cùng `workItemId`, cùng task.
- Tạm ngưng không có giờ reset bị xoá khi resume hoặc chat tiếp (`clearOpenEndedCooldowns`).
- Công việc đã xong trên agent nào thì các lần sau ưu tiên agent đó, trừ khi nó không chạy được.
- Kết quả trả về điều phối viên có `agent` (id, tên, provider); bridge thêm dòng "Thực hiện bởi ...". Quy tắc trong `delegation-policy.js` chỉ áp dụng cho lựa chọn thành viên của điều phối viên.
- Node Pipeline được gọi qua `ask_agent` vẫn chạy đúng một agent như cũ.

### ♻️ Team: chạy tiếp không làm lại việc đã xong
- `run.attempt` tăng mỗi lần resume hoặc chat tiếp (`beginAttempt`); mỗi delegation ghi `attempt`, và khi xong thì ghi `answer`.
- Điều phối viên được chạy tiếp (`coordinatorResumePlan`): mở lại phiên CLI của chính nó nếu cùng agent, provider resume được và cùng thư mục (`task.cwd`); nếu không, hoặc resume thất bại, chạy mới kèm tóm tắt các work item đã xong và câu trả lời của chúng.
- `ask_agent` từ điều phối viên đã resume, trùng `workItemId`, thành viên và `questionFingerprint` của một delegation đã xong ở lần trước: trả lại `answer` đã lưu, không chạy tiến trình, task có `continuation: "replayed"` (`replayDelegation`). Chat tiếp (`activeTurnId`) không bao giờ replay.
- Session id được ghi ngay khi CLI báo (`onSessionId` trong runner), nên sau khi server crash vẫn có phiên để mở lại.
- Thành viên ghi file vào worktree của điều phối viên, nên worktree đó không bị xoá khi điều phối viên dừng hoặc lỗi: `parkWorktree` commit vào nhánh riêng, `reopenWorktree` mở lại đúng thư mục đó khi resume (hoặc chat tiếp). `integrateWorktree` gộp cả các commit đã có sẵn trên nhánh.

### ⛔ Team: giới hạn cho cả run
- `team.limits` (`normalizeTeamLimits`, mặc định `maxDelegations` 30, `callTimeoutMinutes` 30, `runTokenBudget` 2.000.000, 0 = không giới hạn). `teamToGraph` chép vào node điều phối viên (`teamLimits`) để snapshot của run giữ đúng giới hạn lúc bắt đầu; run cũ không có thì không giới hạn.
- `checkTeamLimits` chạy trước mỗi `ask_agent` mới (số lần giao + token) và trước mỗi `spawn_agent` (chỉ token). Lời gọi được replay không bị tính, không bị chặn. Lỗi trả về là tool error bảo điều phối viên viết báo cáo cuối, và được ghi vào log của điều phối viên.
- Hạn giờ: một deadline cho cả lời gọi (kể cả failover). Hết giờ thì `killTaskProcesses(taskId)` giết cả cây tiến trình, lời gọi kết thúc với `failureReason: "timeout"`, không failover, không thử lại.
- `summarize` trả `teamLimits` (`teamLimitSummary`) để tab Run hiện mức dùng so với giới hạn.

### 🌳 Team: worktree riêng cho từng công việc
- Chỉ khi workflow bật isolation và thư mục run là git repo. Executor gọi `openTeamWorkspace` khi điều phối viên bắt đầu (worktree của điều phối viên là "base") và `finishWorkItems` + `closeTeamWorkspace` khi nó xong.
- Thành viên có quyền write/full: mỗi `workItemId` một worktree (`openItemWorktree`, nhánh `ao/<run>/wi-<key>`), tách từ nhánh điều phối viên, dùng lại cho các lần sửa. Thành viên chỉ đọc: làm trong worktree của `reviewOf`, và phải kết thúc bằng `REVIEW: PASS|FAIL` (`parseReviewVerdict`); không có `reviewOf` thì làm ở base.
- Gộp (`integrateWorktree(..., { into: base })`: kiểm thử rồi merge, từng cái một qua hàng đợi `serial`) khi điều phối viên gọi tool `complete_work_item`, hoặc cuối run với công việc có lần review gần nhất đạt. Ghi file sau review đạt thì phải review lại.
- Trạng thái lưu ở `run.workItems[workItemId]`: `branch`, `dir`, `status` (`open`/`integrated`/`failed`), `lastReview`.

---

## API Public (Export)

| Hàm | Mục đích |
|---|---|
| `MODELS` | Danh sách model sẵn có |
| `KNOWN_TOOLS` | Danh sách tool được biết |
| **Agent CRUD** | |
| `listAgents()` | Lấy tất cả agents |
| `getAgent(agentId)` | Lấy agent theo ID |
| `createAgent(input)` | Tạo agent mới |
| `updateAgent(id, input)` | Cập nhật agent |
| `deleteAgent(id)` | Xóa agent |
| **Workflow CRUD** | |
| `listWorkflows()` | Lấy tất cả workflows |
| `getWorkflow(id)` | Lấy workflow theo ID |
| `createWorkflow(input)` | Tạo workflow mới |
| `updateWorkflow(id, input)` | Cập nhật workflow |
| `deleteWorkflow(id)` | Xóa workflow |
| **Run Control** | |
| `startRun({ prompt, agentId, decompose, cwd })` | Bắt đầu ad-hoc run |
| `startWorkflowRun({ prompt, workflowId, cwd })` | Bắt đầu workflow run |
| `listRuns()` | Lấy tất cả runs (sorted by createdAt desc) |
| `getRun(runId)` | Lấy run theo ID |
| **Event** | |
| `subscribe(fn)` | Đăng ký event listener (return unsubscribe fn) |
| **Config** | |
| `DEFAULT_CWD` | Thư mục làm việc mặc định |

---

## Cách `server/index.js` dùng orchestrator

Các endpoint HTTP/WebSocket gọi hàm export:

- **GET `/api/agents`** → `listAgents()`
- **GET `/api/agents/:id`** → `getAgent(id)`
- **POST `/api/agents`** → `createAgent(req.body)`
- **PUT `/api/agents/:id`** → `updateAgent(id, req.body)`
- **DELETE `/api/agents/:id`** → `deleteAgent(id)`

- **GET `/api/workflows`** → `listWorkflows()`
- **GET `/api/workflows/:id`** → `getWorkflow(id)`
- **POST `/api/workflows`** → `createWorkflow(req.body)`
- **PUT `/api/workflows/:id`** → `updateWorkflow(id, req.body)`
- **DELETE `/api/workflows/:id`** → `deleteWorkflow(id)`

- **POST `/api/run`** → `startRun(req.body)` → `runId`
- **POST `/api/run-workflow`** → `startWorkflowRun(req.body)` → `runId`
- **GET `/api/runs`** → `listRuns()`
- **GET `/api/runs/:id`** → `getRun(id)`

- **WS `/ws`** → `subscribe(callback)` → stream events as WebSocket messages

---

**Tóm lại:** Orchestrator là **orchestration layer** tách biệt khỏi HTTP, quản lý agent/workflow config, chạy agents qua Claude CLI, stream log realtime qua event bus, và cung cấp API clean cho REST/WebSocket layer.

### 📸 Chạy trên repo có thay đổi chưa commit
- `openWorkspaceSession` không còn từ chối repo bẩn. Khi nhánh đích là nhánh đang checkout và có thay đổi chưa commit, `snapshotWorkingTree` chụp chúng thành một commit (index tạm, `git add -A`, `write-tree`, `commit-tree`), giữ ở `refs/ao/snapshot/<run>`; thư mục, index và HEAD của người dùng không bị đụng tới.
- Worktree review tách từ snapshot đó và `baseCommit` = snapshot, nên diff review chỉ có phần agent sửa. Resume và chat tiếp đọc lại ref này.
- Accept (`acceptIntoWorkingTree`): kiểm tra từng file agent sửa vẫn giống hệt bản snapshot (`hash-object --path`), rồi ghi bằng `git restore --worktree`; không commit, không đổi HEAD. Có file bị người dùng sửa sau khi run bắt đầu thì từ chối và không ghi gì. Run bắt đầu trên repo sạch nhưng lúc Accept thư mục đã bẩn cũng đi đường này (so với `baseCommit`).
- Ref snapshot bị xoá cùng worktree review (`cleanupReviewWorkspace`).
