import React, { useEffect } from "react";
import { usePreferences } from "../PreferencesContext.jsx";
import { usePageMeta } from "../PageMetaContext.jsx";

// Each section is a list of blocks:
//   { type: "p", text }       — plain paragraph
//   { type: "h4", text }      — subheading inside the section
//   { type: "steps", items }  — numbered click-by-click steps
const CONTENT = {
  vi: {
    title: "Hướng dẫn sử dụng",
    subtitle: "Tài liệu tổng quan cho Agents Orchestrator",
    sections: [
      {
        id: "overview",
        heading: "1. Tổng quan",
        blocks: [
          { type: "p", text: "Đây là hệ thống local: bạn gõ 1 yêu cầu, hệ thống spawn tiến trình CLI thật cho từng agent — `claude -p` (Claude Code) hoặc `codex exec` (Codex CLI), tuỳ provider bạn chọn cho agent đó — không cần API key riêng, dùng chính phiên đăng nhập CLI có sẵn trên máy bạn." },
          { type: "p", text: "4 khối cấu hình chính: Agents (ai làm việc, chạy bằng CLI nào), Skills (kiến thức dùng chung), Plugins (plugin Claude Code thật), Workflows (nhiều agent phối hợp). Tab Chạy dùng để khởi động và xem tiến trình; lịch sử run được lưu lại, sống qua cả lúc restart server." },
        ],
      },
      {
        id: "agents",
        heading: "2. Agents",
        blocks: [
          { type: "p", text: "Trường đầu tiên và quan trọng nhất khi tạo agent là \"CLI thực thi\" (provider): Claude Code hoặc Codex — quyết định agent này chạy bằng `claude -p` hay `codex exec`. CLI nào chưa cài trên máy sẽ bị disable trong dropdown (kèm cảnh báo), tránh tạo agent chắc chắn lỗi khi chạy." },
          { type: "h4", text: "Agent Claude Code" },
          { type: "p", text: "Chọn model (Sonnet/Opus/Haiku/Fable hoặc mặc định), permission mode, danh sách tool được phép / bị cấm, và bật \"Chỉ đọc\" để tự động cấm Edit/Write (an toàn cho việc review)." },
          { type: "p", text: "Trong danh sách tool có 1 tool đặc biệt: \"Tạo sub-agent\" — tick vào là agent này được phép tự tạo sub-agent để chia nhỏ và làm song song một phần việc, rồi tự tổng hợp kết quả. Chỉ cần tick, KHÔNG cần viết gì thêm trong prompt: hệ thống tự thêm hướng dẫn vào system prompt lúc chạy, agent tự quyết định khi nào nên tách việc và giao gì cho từng sub-agent. Hoạt động của sub-agent hiện luôn trong log của bước đó." },
          { type: "p", text: "Phân biệt với \"Gọi 2 chiều\" (mục 6): sub-agent ở đây là agent tạm, kiểu chung chung (general-purpose), do chính agent tự sinh ra lúc chạy — khác với việc gọi một agent CỤ THỂ bạn đã cấu hình sẵn (đúng model/skill/tool riêng) qua ask_agent trong workflow." },
          { type: "h4", text: "Agent Codex" },
          { type: "p", text: "Model là dropdown đọc trực tiếp từ `~/.codex/models_cache.json` — chính là danh sách model thật tài khoản Codex CLI của bạn đã fetch lúc login, luôn khớp với những gì bạn thực sự dùng được, không phải danh sách cứng có thể lỗi thời." },
          { type: "p", text: "Quyền hạn cho Codex khác Claude: `codex exec` (chế độ non-interactive dùng ở đây) không có cờ approval-mode như phiên bản tương tác, nên chỉ có 2 trục thật sự điều khiển được — Sandbox (`read-only` / `workspace-write` / `danger-full-access`) và checkbox \"Cho phép truy cập mạng trong sandbox\" (chỉ có tác dụng khi Sandbox = workspace-write). Không có allow/disallow tool riêng lẻ, không gắn được plugin, và không tham gia được cơ chế \"Gọi 2 chiều\" (xem mục 6)." },
          { type: "p", text: "Bật \"Chỉ đọc\" tự set an toàn cho cả 2 provider (Claude: plan mode + cấm Edit/Write; Codex: sandbox read-only)." },
          { type: "h4", text: "Skill riêng & xoá agent" },
          { type: "p", text: "Skill riêng: đoạn system prompt chỉ agent đó dùng (với Codex, nội dung được chèn vào đầu prompt thay vì dùng cờ riêng vì Codex không có `--append-system-prompt`). Skill dùng chung: gắn 1 hoặc nhiều skill từ thư viện Skills." },
          { type: "p", text: "Plugin: gắn plugin Claude Code thật (đã cài ở tab Plugins) — chỉ áp dụng cho agent provider Claude Code, chạy với `--plugin-dir`/`--plugin-url` tương ứng." },
          { type: "p", text: "Xoá agent đang được 1 workflow tham chiếu sẽ bị chặn — hệ thống báo rõ tên (các) workflow đang dùng, phải gỡ khỏi workflow đó trước rồi mới xoá được. Mọi thao tác xoá (agent, skill, run...) đều mở popup xác nhận riêng của app, không dùng hộp thoại mặc định của trình duyệt." },
        ],
      },
      {
        id: "skills",
        heading: "3. Skills",
        blocks: [
          { type: "p", text: "Skill là 1 đoạn hướng dẫn/kiến thức tái sử dụng (vd: quy ước commit message, coding style riêng của dự án). Soạn 1 lần ở tab Skills, gắn cho bao nhiêu agent tuỳ ý ở form Agent." },
          { type: "p", text: "Xoá 1 skill đang được agent nào gắn cũng bị chặn tương tự agent — báo rõ tên (các) agent đang dùng, gỡ khỏi agent đó trước rồi mới xoá được." },
        ],
      },
      {
        id: "plugins",
        heading: "4. Plugins",
        blocks: [
          { type: "p", text: "Đây là plugin Claude Code thật (có `.claude-plugin/plugin.json`), không phải giả lập — ví dụ github.com/DietrichGebert/ponytail." },
          { type: "p", text: "3 kiểu nguồn: Git repo (hệ thống tự `git clone` vào server/plugins/<id>), thư mục local có sẵn, hoặc URL file .zip plugin. Gắn plugin cho agent nào cần ở form Agent, mục \"Plugin Claude Code\"." },
        ],
      },
      {
        id: "workflows",
        heading: "5. Workflows — sơ đồ nhiều agent",
        blocks: [
          { type: "p", text: "Workflow là 1 đồ thị (node + cạnh), không chỉ chuỗi thẳng: node có thể phân nhánh song song, hoặc gộp nhiều nhánh vào 1 node (merge)." },
          { type: "h4", text: "Tạo node & nối cạnh" },
          {
            type: "steps",
            items: [
              "Vào tab Workflows → bấm \"+ Tạo workflow mới\", hoặc \"Sửa\" trên 1 workflow có sẵn.",
              "Canvas trống → bấm \"Thêm bước đầu tiên\" để tạo node gốc.",
              "Trên mỗi node đang có, rê chuột vào góc trên-phải node để lộ 2 nút nhỏ: dấu \"+\" (thêm node con, tự nối cạnh) và dấu \"✕\" (xoá node).",
              "Click vào 1 node để chọn — panel sửa hiện bên phải: mục \"General\" (luôn hiện) cho chọn agent + viết prompt cho node đó.",
              "Muốn nối 1 cạnh tới node ĐÃ CÓ SẴN (thay vì tạo node mới) — chọn node nguồn → tab \"Branches\" → ở dropdown chọn tên agent muốn nối tới (thay vì \"+ Tạo node mới\") → bấm \"+ Thêm nhánh\". Đây là cách tạo fan-in/merge (nhiều node cùng dẫn vào 1 node).",
              "Kéo thả node bất kỳ để sắp xếp lại vị trí trên canvas (giữ chuột và kéo, không phải click). Cuộn chuột để zoom, kéo nền canvas để pan.",
            ],
          },
          { type: "p", text: "Prompt của mỗi node có thể dùng {{prompt}} = yêu cầu gốc, {{previous}} = kết quả (các) node trước dẫn vào; để trống thì hệ thống tự ghép mặc định." },
        ],
      },
      {
        id: "interaction",
        heading: "6. 3 cách agent tương tác với nhau (chi tiết)",
        blocks: [
          { type: "p", text: "Có 3 cơ chế, từ đơn giản/tĩnh tới mạnh/linh hoạt. Chọn cơ chế theo đúng nhu cầu — không cần dùng cả 3 cùng lúc." },

          { type: "h4", text: "Cách 1 — Nối cạnh: truyền dữ liệu 1 chiều, tự động" },
          {
            type: "steps",
            items: [
              "Chọn node nguồn trên canvas.",
              "Bấm nút \"+\" nhỏ ở góc node để tạo node con mới và tự nối cạnh — HOẶC vào tab \"Branches\" ở panel bên phải, chọn 1 node có sẵn trong dropdown rồi bấm \"+ Thêm nhánh\" để nối tới node đó.",
              "Xong — không cần cấu hình gì thêm. Khi chạy, node đích tự động chạy ngay khi node nguồn xong, nhận {{previous}} là kết quả của node nguồn.",
            ],
          },
          { type: "p", text: "Dùng khi: các bước có thứ tự cố định, biết trước, không cần \"quyết định\" xem có gọi hay không — cứ xong bước trước là chạy bước sau (hoặc chạy song song nếu 1 node có nhiều cạnh ra)." },

          { type: "h4", text: "Cách 2 — Router: định tuyến theo điều kiện" },
          {
            type: "steps",
            items: [
              "Chọn node muốn làm bộ định tuyến (thường là node đã có sẵn 2+ nhánh ra).",
              "Panel bên phải → tab \"Trigger\" → tick ô \"Router (auto-picks one branch based on its result)\".",
              "Sang tab \"Branches\" — với mỗi nhánh ra, giờ sẽ xuất hiện thêm 1 ô nhập \"condition\" (chỉ hiện khi node là Router) — gõ 1 từ khoá ngắn, vd \"bug\" hoặc \"ok\".",
              "Lưu workflow.",
            ],
          },
          { type: "p", text: "Khi chạy: node Router trả lời xong, hệ thống so khớp câu trả lời với từng từ khoá \"condition\" (không phân biệt hoa/thường) — nhánh nào khớp thì chạy tiếp, các nhánh còn lại tự động chuyển badge \"Bỏ qua\" (không chạy, không tốn chi phí)." },
          { type: "p", text: "Dùng khi: cần rẽ nhánh dựa trên kết quả — ví dụ node kiểm tra phát hiện có bug thì rẽ sang node Fix Bug, không thì rẽ sang node Viết Docs." },

          { type: "h4", text: "Cách 3 — Gọi 2 chiều (ask_agent): 1 node tự quyết định gọi ai, lúc nào" },
          { type: "p", text: "Đây là cơ chế mạnh nhất: node A có thể chủ động hỏi node B NGAY GIỮA LÚC ĐANG CHẠY, CHỜ nhận câu trả lời đầy đủ của B rồi mới tiếp tục việc của mình — giống 1 Project Manager giao việc rồi đợi báo cáo trước khi giao việc tiếp theo. Thứ tự gọi KHÔNG cố định trong sơ đồ — do chính agent (LLM) tự quyết định lúc chạy, dựa theo prompt bạn viết." },
          {
            type: "steps",
            items: [
              "Chọn node \"người gọi\" (vd: Project Manager).",
              "Panel bên phải → tab \"Two-way calls\".",
              "Click vào chip tên từng node bạn muốn node này ĐƯỢC PHÉP gọi — chip chuyển màu đỏ (đã chọn) khi click, và hiện luôn id thật của node đó (vd: `nextjs-frontend-engineer · id=\"nwvl6e3\"`). Có thể chọn nhiều node.",
              "Quan trọng — sang tab \"General\", sửa ô Prompt của node gọi để RA LỆNH rõ ràng: gọi ai trước, gọi ai sau, gửi gì cho từng node. Hệ thống chỉ cấp QUYỀN gọi (ai được gọi ai) — còn THỨ TỰ và NỘI DUNG gọi hoàn toàn do agent tự quyết định lúc chạy theo prompt này.",
              "Khuyên dùng — chọn từng node B/C (node bị gọi) → tab \"Trigger\" → tick \"Only runs when called directly (doesn't auto-start with the workflow)\". Việc này khiến node B/C KHÔNG tự chạy theo sơ đồ nữa (dù là node gốc hay có cạnh dẫn vào) — chỉ chạy đúng lúc bị gọi qua ask_agent. Nếu bỏ qua bước này, node B/C có thể vừa tự chạy theo sơ đồ VỪA bị gọi lại — chạy trùng, sai ý đồ.",
              "Không cần nối cạnh (Branches) giữa các node dùng cơ chế gọi 2 chiều — quan hệ gọi hoàn toàn độc lập với cạnh đồ thị (cạnh đồ thị chỉ hiện đường nét đứt tím có mũi tên, không phải cạnh dữ liệu).",
            ],
          },
          { type: "p", text: "Về id: mỗi node có 1 id riêng, hiện ở 3 chỗ — ngay trên sơ đồ (dưới tên node), ở khung boxed \"Id của bước này\" trong tab General, và trên chip ở tab \"Gọi 2 chiều\". Đây là id cần dùng khi node gọi tới nó qua ask_agent — khác với id của agent bên tab Agents. Thực ra bạn KHÔNG bắt buộc phải tự chép id vào prompt: chỉ cần nhắc tên agent, model tự thấy đúng id vì danh sách node được phép gọi (kèm id) đã tự động nhét vào mô tả của chính tool ask_agent lúc chạy — nhưng hardcode id vào prompt (như ví dụ dưới) vẫn nên làm khi dùng model yếu hơn, để tránh gọi nhầm giữa các node trùng tên gần giống nhau." },
          { type: "p", text: "Giới hạn an toàn: tối đa 3 lớp gọi lồng nhau (chống vòng lặp gọi nhau vô hạn); 1 node không thể tự gọi chính nó; mỗi cuộc gọi hiện thành 1 task riêng \"💬 ... hỏi ...\" trong run để xem log hỏi/đáp đầy đủ." },

          { type: "h4", text: "Ví dụ thực tế: PM → Frontend Engineer → Code Reviewer" },
          {
            type: "steps",
            items: [
              "Tab Agents: tạo 3 agent riêng — \"Project Manager\", \"Frontend Engineer\", \"Code Reviewer\" (mỗi agent có model/tool/skill phù hợp vai trò).",
              "Tab Workflows: tạo workflow mới, bấm \"Thêm bước đầu tiên\" để tạo node PM, sau đó dùng nút \"+\" HOẶC dropdown \"Branches\" để thêm 2 node còn lại (FE, Reviewer) — không cần nối cạnh có ý nghĩa giữa 3 node này, vì quan hệ thật sẽ đi qua Two-way calls.",
              "Chọn node PM → tab \"Two-way calls\" → click chọn cả chip Frontend Engineer và Code Reviewer.",
              "Vẫn ở node PM → tab \"General\" → viết prompt kiểu: \"Bước 1: dùng ask_agent gọi Frontend Engineer, giao việc, CHỜ code xong. Bước 2: dùng ask_agent gọi Code Reviewer, gửi kèm mô tả thay đổi để review, CHỜ nhận xét. Bước 3: tổng hợp báo cáo cuối.\"",
              "Chọn node Frontend Engineer → tab \"Trigger\" → tick \"Only runs when called directly...\".",
              "Chọn node Code Reviewer → tab \"Trigger\" → tick \"Only runs when called directly...\" (giờ cả 2 node đều hiện badge \"chỉ gọi thủ công\" trên canvas).",
              "Bấm \"Save\". Sang tab Chạy → chọn chế độ \"Workflow\" → chọn workflow vừa tạo → nhập yêu cầu tính năng → bấm \"Chạy\".",
            ],
          },
          { type: "p", text: "Kết quả: PM chạy trước tiên (là node duy nhất tự khởi động) → tự gọi FE, đợi FE code xong thật → tự gọi Reviewer, đợi review xong → PM tổng hợp báo cáo cuối cùng. Toàn bộ 2 cuộc gọi hiện thành 2 task \"💬 PM hỏi ...\" riêng biệt trong run, xem được log hỏi/đáp đầy đủ của từng cuộc gọi." },
        ],
      },
      {
        id: "run",
        heading: "7. Chạy",
        blocks: [
          { type: "p", text: "2 chế độ: \"Workflow\" (chạy 1 workflow đã soạn) hoặc \"1 Agent\" (chạy 1 agent đơn, có thể bật \"Tự chia nhỏ thành nhiều subagent\" để AI tự phân rã yêu cầu lớn)." },
          { type: "p", text: "Chọn workflow xong, sơ đồ hiện ngay ở khu vực bên phải (trước khi chạy) để xem trước cấu trúc. Khi chạy, sơ đồ tô màu live theo trạng thái từng node: xám=chờ, vàng nhấp nháy=đang chạy, xanh=xong, đỏ=lỗi, mờ nét đứt=bị bỏ qua (router không chọn)." },
          { type: "p", text: "Thư mục làm việc: gõ tay hoặc bấm \"Duyệt...\" để mở trình duyệt thư mục (đọc trực tiếp từ ổ đĩa máy bạn, không cần dialog OS)." },
          { type: "h4", text: "Lịch sử run: lưu lại, xoá được, an toàn khi chuyển trang" },
          { type: "p", text: "Chuyển sang tab khác trong lúc 1 run đang chạy KHÔNG dừng nó lại — workflow chạy hoàn toàn ở phía server, độc lập với việc bạn có đang mở trang Chạy hay không. Quay lại tab Chạy, click vào run đó trong \"Lịch sử chạy\" để xem lại đầy đủ log/kết quả và tiếp tục theo dõi realtime nếu vẫn đang chạy." },
          { type: "p", text: "Lịch sử run được ghi ra file, sống qua cả lúc restart server — không còn mất khi tắt/bật lại. Nếu server bị tắt/crash đúng lúc 1 run đang chạy dở, lần khởi động sau sẽ tự đánh dấu run đó \"Lỗi\" kèm giải thích, log/kết quả đã có tới thời điểm đó vẫn giữ nguyên." },
          { type: "p", text: "Xoá từng run (nút 🗑 hiện khi hover) hoặc \"Xoá tất cả\" ở đầu danh sách — cả hai đều có popup xác nhận và đều từ chối xoá run đang chạy (\"Xoá tất cả\" thì tự bỏ qua các run đang chạy thay vì báo lỗi cả loạt)." },
        ],
      },
      {
        id: "limits",
        heading: "8. Giới hạn hiện tại",
        blocks: [
          { type: "p", text: "Chưa có nút \"dừng\" một run đang chạy giữa chừng." },
          { type: "p", text: "Agent provider Codex không tham gia được cơ chế \"Gọi 2 chiều\" (ask_agent) — cơ chế này hiện chỉ wiring cho Claude Code; 1 node Codex vẫn chạy bình thường qua cạnh thường trong workflow, chỉ không gọi/không bị gọi qua ask_agent được." },
          { type: "p", text: "Nhiều agent ghi file song song trong cùng 1 thư mục có thể xung đột — cân nhắc dùng git worktree riêng nếu cần chạy song song an toàn trên cùng repo." },
        ],
      },
    ],
  },
  en: {
    title: "Usage guide",
    subtitle: "Overview documentation for Agents Orchestrator",
    sections: [
      {
        id: "overview",
        heading: "1. Overview",
        blocks: [
          { type: "p", text: "This is a local system: you type one request, it spawns real CLI processes for each agent — `claude -p` (Claude Code) or `codex exec` (Codex CLI), depending on the provider you pick per agent — no separate API key needed, it uses whichever CLI login you already have on your machine." },
          { type: "p", text: "Four building blocks: Agents (who does the work, and which CLI runs it), Skills (shared knowledge), Plugins (real Claude Code plugins), Workflows (multiple agents working together). The Run tab starts things and shows live progress; run history is saved and survives a server restart." },
        ],
      },
      {
        id: "agents",
        heading: "2. Agents",
        blocks: [
          { type: "p", text: "The first and most important field when creating an agent is \"Runs on\" (provider): Claude Code or Codex — decides whether this agent runs via `claude -p` or `codex exec`. Any CLI not installed on the machine is disabled in the dropdown (with a warning), so you can't create an agent that's guaranteed to fail." },
          { type: "h4", text: "Claude Code agents" },
          { type: "p", text: "Pick a model (Sonnet/Opus/Haiku/Fable or default), permission mode, allowed/disallowed tools, and toggle \"Read-only\" to auto-block Edit/Write (safe for reviews)." },
          { type: "p", text: "One tool in that list is special: \"Spawn sub-agents\" — tick it and this agent may create its own sub-agents to work on parts of a task in parallel, then combine their results. Ticking it is the whole setup: you do NOT need to mention it in the prompt, the system adds the guidance to the system prompt at run time and the agent decides on its own when to split work and what to delegate. Sub-agent activity shows up in that step's log." },
          { type: "p", text: "Not the same as \"Two-way calls\" (section 6): a sub-agent here is a throwaway, general-purpose agent the agent itself spawns at run time — as opposed to calling one SPECIFIC agent you configured (with its own model/skills/tools) via ask_agent in a workflow." },
          { type: "h4", text: "Codex agents" },
          { type: "p", text: "The model is a dropdown read straight from `~/.codex/models_cache.json` — the real model list your Codex CLI account fetched on login, so it always matches what you can actually use, not a hardcoded list that can go stale." },
          { type: "p", text: "Permissions work differently than Claude: `codex exec` (the non-interactive mode used here) has no approval-mode flag like the interactive CLI does, so there are only two real permission knobs — Sandbox (`read-only` / `workspace-write` / `danger-full-access`) and a \"Allow network access inside the sandbox\" checkbox (only takes effect when Sandbox = workspace-write). No per-tool allow/disallow list, no plugin support, and it can't take part in the \"Two-way calls\" mechanism (see section 6)." },
          { type: "p", text: "Toggling \"Read-only\" sets a safe default for either provider (Claude: plan mode + block Edit/Write; Codex: read-only sandbox)." },
          { type: "h4", text: "Private skill & deleting an agent" },
          { type: "p", text: "Private skill: system-prompt text only that agent uses (for a Codex agent, this content is prepended to the prompt instead, since Codex has no `--append-system-prompt` flag). Shared skills: attach one or more skills from the Skills library." },
          { type: "p", text: "Plugin: attach a real Claude Code plugin (installed in the Plugins tab) — Claude Code agents only, runs with the matching `--plugin-dir`/`--plugin-url`." },
          { type: "p", text: "Deleting an agent still referenced by a workflow is blocked — the system names which workflow(s) use it; remove it from those first. Every delete action (agent, skill, run...) opens the app's own confirmation popup, never the browser's built-in dialog." },
        ],
      },
      {
        id: "skills",
        heading: "3. Skills",
        blocks: [
          { type: "p", text: "A skill is a reusable chunk of instructions/knowledge (e.g. commit-message conventions, a project's coding style). Write it once in the Skills tab, attach it to as many agents as you like from the Agent form." },
          { type: "p", text: "Deleting a skill still attached to an agent is blocked the same way — it names which agent(s) use it; remove it from those first." },
        ],
      },
      {
        id: "plugins",
        heading: "4. Plugins",
        blocks: [
          { type: "p", text: "These are real Claude Code plugins (with a `.claude-plugin/plugin.json`), not a simulation — e.g. github.com/DietrichGebert/ponytail." },
          { type: "p", text: "Three source types: Git repo (auto `git clone`d into server/plugins/<id>), an existing local directory, or a plugin .zip URL. Attach a plugin to any agent that needs it under \"Claude Code plugin\" in the Agent form." },
        ],
      },
      {
        id: "workflows",
        heading: "5. Workflows — a multi-agent diagram",
        blocks: [
          { type: "p", text: "A workflow is a graph (nodes + edges), not just a straight chain: nodes can fan out in parallel, or several branches can merge back into one node." },
          { type: "h4", text: "Creating nodes & connecting edges" },
          {
            type: "steps",
            items: [
              "Go to the Workflows tab → click \"+ New workflow\", or \"Edit\" on an existing one.",
              "On an empty canvas, click \"Add first step\" to create the root node.",
              "Hover any existing node's top-right corner to reveal two small buttons: \"+\" (add a child node, auto-connected) and \"✕\" (delete the node).",
              "Click a node to select it — the edit panel opens on the right: the \"General\" section (always visible) is where you pick the agent and write that node's prompt.",
              "To connect an edge to an EXISTING node instead of creating a new one — select the source node → \"Branches\" tab → pick the target agent's name from the dropdown (instead of \"+ Create new node\") → click \"+ Add branch\". That's how you build a fan-in/merge (several nodes feeding into one).",
              "Drag any node to reposition it on the canvas (press and drag, not a click). Scroll to zoom, drag the empty background to pan.",
            ],
          },
          { type: "p", text: "Each node's prompt can use {{prompt}} = the original request, {{previous}} = the incoming node(s)' output; leave it empty and the system fills in a sensible default." },
        ],
      },
      {
        id: "interaction",
        heading: "6. The 3 ways agents interact — in detail",
        blocks: [
          { type: "p", text: "There are 3 mechanisms, from simple/static to powerful/dynamic. Pick the one that fits — you don't need all three at once." },

          { type: "h4", text: "Method 1 — Edges: automatic, one-way data flow" },
          {
            type: "steps",
            items: [
              "Select the source node on the canvas.",
              "Click the small \"+\" on the node's corner to create a new child node with an auto-connected edge — OR go to the \"Branches\" tab in the right panel, pick an existing node from the dropdown, then click \"+ Add branch\" to connect to it.",
              "That's it — nothing else to configure. When run, the target node automatically starts as soon as the source node finishes, receiving {{previous}} = the source node's output.",
            ],
          },
          { type: "p", text: "Use this when: the steps have a fixed, known order and don't need a \"decision\" about whether to call — the next step just runs once the previous one is done (or in parallel if a node has several outgoing edges)." },

          { type: "h4", text: "Method 2 — Router: conditional branching" },
          {
            type: "steps",
            items: [
              "Select the node you want to act as a router (usually one that already has 2+ outgoing branches).",
              "Right panel → \"Trigger\" tab → check \"Router (auto-picks one branch based on its result)\".",
              "Switch to the \"Branches\" tab — each outgoing branch now shows an extra \"condition\" input (only appears when the node is a Router) — type a short keyword, e.g. \"bug\" or \"ok\".",
              "Save the workflow.",
            ],
          },
          { type: "p", text: "At run time: once the Router node answers, the system matches its answer against each branch's \"condition\" keyword (case-insensitive) — the matching branch runs, the rest automatically get a \"Skipped\" badge (never run, no cost)." },
          { type: "p", text: "Use this when: you need to branch based on a result — e.g. a check node that found a bug routes to a Fix Bug node, otherwise it routes to a Write Docs node." },

          { type: "h4", text: "Method 3 — Two-way calls (ask_agent): one node decides who to call and when" },
          { type: "p", text: "The most powerful mechanism: node A can actively ask node B WHILE IT'S RUNNING, BLOCK for B's full answer, then keep going with it — like a Project Manager assigning work and waiting for a report before assigning the next task. The calling order is NOT fixed in the diagram — the agent (the LLM) decides it at run time, based on the prompt you write." },
          {
            type: "steps",
            items: [
              "Select the \"caller\" node (e.g. Project Manager).",
              "Right panel → \"Two-way calls\" tab.",
              "Click each node's chip you want this node to be ALLOWED to call — the chip turns red (selected) on click, and always shows that node's real id (e.g. `nextjs-frontend-engineer · id=\"nwvl6e3\"`). You can select several.",
              "Important — switch to the \"General\" tab and edit the caller node's prompt to explicitly INSTRUCT it: call who first, call who next, what to send each one. The system only grants PERMISSION to call (who may call whom) — the ORDER and CONTENT of each call is entirely up to the agent at run time, based on this prompt.",
              "Recommended — for each callee node (B/C) → \"Trigger\" tab → check \"Only runs when called directly (doesn't auto-start with the workflow)\". This stops B/C from auto-starting as part of the graph (whether as a root or via an incoming edge) — it will only run exactly when called via ask_agent. Skip this and B/C could BOTH auto-run from the graph AND get called again — running twice, against your intent.",
              "No need to connect edges (Branches) between nodes using two-way calls — the call relationship is entirely independent of graph edges (they're drawn as a dashed purple arrow, not a data edge).",
            ],
          },
          { type: "p", text: "About ids: every node has its own id, shown in 3 places — right on the diagram (under the node's title), in the boxed \"This step's id\" field in the General tab, and on each chip in the \"Two-way calls\" tab. That's the id another node needs to reach it via ask_agent — not the agent's own id from the Agents tab. You don't actually have to copy the id into the prompt yourself: just mention the agent by name and the model will find the right id, since the list of callable nodes (with ids) is automatically included in the ask_agent tool's own description at run time — but hardcoding the id (like the worked example below does) is still worth doing with a weaker model, to avoid it mixing up nodes with similar names." },
          { type: "p", text: "Safety limits: max 3 nested call levels (prevents infinite call loops); a node can never call itself; each call shows up as its own \"💬 ... asked ...\" task in the run so you can see the full question/answer log." },

          { type: "h4", text: "Worked example: PM → Frontend Engineer → Code Reviewer" },
          {
            type: "steps",
            items: [
              "Agents tab: create 3 separate agents — \"Project Manager\", \"Frontend Engineer\", \"Code Reviewer\" (each with a model/tools/skills fitting its role).",
              "Workflows tab: create a new workflow, click \"Add first step\" for the PM node, then use \"+\" OR the \"Branches\" dropdown to add the other two nodes (FE, Reviewer) — the edges between them don't need to carry real meaning, since the actual relationship goes through Two-way calls.",
              "Select the PM node → \"Two-way calls\" tab → click both the Frontend Engineer and Code Reviewer chips.",
              "Still on the PM node → \"General\" tab → write a prompt like: \"Step 1: use ask_agent to call Frontend Engineer, assign the task, WAIT for the code to be done. Step 2: use ask_agent to call Code Reviewer, send it a summary of the changes to review, WAIT for feedback. Step 3: write a final report.\"",
              "Select the Frontend Engineer node → \"Trigger\" tab → check \"Only runs when called directly...\".",
              "Select the Code Reviewer node → \"Trigger\" tab → check \"Only runs when called directly...\" (both nodes now show a \"manual call only\" badge on the canvas).",
              "Click \"Save\". Go to the Run tab → \"Workflow\" mode → pick this workflow → enter the feature request → click \"Run\".",
            ],
          },
          { type: "p", text: "Result: PM runs first (the only node that auto-starts) → it calls FE, waits for the FE agent to actually finish writing code → it calls Reviewer, waits for the review → PM writes the final report. Both calls show up as two separate \"💬 PM asked ...\" tasks in the run, each with its full question/answer log." },
        ],
      },
      {
        id: "run",
        heading: "7. Run",
        blocks: [
          { type: "p", text: "Two modes: \"Workflow\" (run a saved workflow) or \"1 Agent\" (run a single agent, optionally with \"Auto-decompose into sub-agents\" so the AI splits a big request itself)." },
          { type: "p", text: "Once you pick a workflow, its diagram shows immediately on the right (before running) as a preview. While running, the diagram colors live per node: gray=pending, pulsing amber=running, green=done, red=error, dim dashed=skipped (router didn't pick it)." },
          { type: "p", text: "Working directory: type it or click \"Browse...\" to open an in-app directory browser (reads straight from your machine's disk, no OS dialog needed)." },
          { type: "h4", text: "Run history: persisted, deletable, safe to navigate away from" },
          { type: "p", text: "Switching to another tab while a run is in progress does NOT stop it — the workflow runs entirely server-side, independent of whether you have the Run page open. Come back to the Run tab and click that run in \"Run history\" to see its full log/output again and keep watching it live if it's still going." },
          { type: "p", text: "Run history is written to disk and survives a server restart — it's no longer lost on shutdown/restart. If the server is killed or crashes while a run is mid-flight, the next startup marks that run \"Error\" with an explanation; whatever log/output it had accumulated up to that point is kept as-is." },
          { type: "p", text: "Delete a single run (🗑 button, shown on hover) or \"Clear all\" at the top of the list — both open a confirmation popup and both refuse to delete a still-running run (\"Clear all\" just skips running ones instead of erroring out the whole action)." },
        ],
      },
      {
        id: "limits",
        heading: "8. Current limitations",
        blocks: [
          { type: "p", text: "No \"stop\" button for a run in progress yet." },
          { type: "p", text: "Codex-provider agents can't take part in the \"Two-way calls\" (ask_agent) mechanism — it's currently only wired up for Claude Code; a Codex node still runs fine in a workflow via regular edges, it just can't call or be called via ask_agent." },
          { type: "p", text: "Multiple agents writing files in parallel in the same directory can conflict — consider a separate git worktree per agent if you need safe parallel writes on the same repo." },
        ],
      },
    ],
  },
};

function Block({ block }) {
  if (block.type === "h4") return <h4 className="docs-subheading">{block.text}</h4>;
  if (block.type === "steps") {
    return (
      <ol className="docs-steps">
        {block.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ol>
    );
  }
  return <p className="docs-paragraph">{block.text}</p>;
}

export default function DocsPage() {
  const { locale, t } = usePreferences();
  const { setMeta } = usePageMeta();
  const doc = CONTENT[locale] || CONTENT.vi;

  useEffect(() => {
    setMeta({ title: doc.title, subtitle: doc.subtitle });
    return () => setMeta(null);
  }, [locale]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tab-content docs-page">
      <nav className="docs-toc">
        {doc.sections.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.heading}
          </a>
        ))}
      </nav>

      <div className="docs-body">
        {doc.sections.map((s) => (
          <section key={s.id} id={s.id} className="panel-card docs-section">
            <h3>{s.heading}</h3>
            {s.blocks.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
