import React, { useEffect } from "react";
import { usePreferences } from "../PreferencesContext.jsx";
import { usePageMeta } from "../PageMetaContext.jsx";

// Each section is a list of blocks:
//   { type: "p", text }       plain paragraph
//   { type: "h4", text }      subheading inside the section
//   { type: "steps", items }  numbered click-by-click steps
const CONTENT = {
  vi: {
    title: "Hướng dẫn sử dụng",
    subtitle: "Tài liệu tổng quan cho Agents Orchestrator",
    sections: [
      {
        id: "overview",
        heading: "1. Tổng quan",
        blocks: [
          { type: "p", text: "Hệ thống chạy hoàn toàn ở máy bạn. Bạn gõ một yêu cầu, server sinh ra tiến trình CLI thật cho từng agent: `claude -p` cho Claude Code, `codex exec` cho Codex, `agy --print` cho Gemini. Không có chỗ nào nhập API key vì không cần, mỗi tiến trình dùng luôn phiên đăng nhập CLI sẵn có trên máy." },
          { type: "p", text: "Có 4 phần cấu hình. Agents là ai làm việc và chạy bằng CLI nào, Skills là kiến thức dùng chung, Plugins là plugin Claude Code thật, Workflows là cách nhiều agent phối hợp. Tab Chạy để khởi động và theo dõi tiến trình. Lịch sử run được ghi ra file nên không mất khi restart server." },
        ],
      },
      {
        id: "agents",
        heading: "2. Agents",
        blocks: [
          { type: "p", text: "Trường quan trọng nhất khi tạo agent là CLI thực thi: Claude Code, Codex hay Gemini (lệnh agy). Chọn xong thì phần còn lại của form đổi theo. CLI nào chưa cài trên máy sẽ bị mờ trong dropdown kèm cảnh báo." },
          { type: "h4", text: "Mỗi loại quyền chỉ khai báo ở một chỗ" },
          { type: "p", text: "Agent khai báo agent này tự làm được gì — đây là trần quyền. Workflow khai báo agent được giao việc cho ai và được tạo thêm ai, và không bao giờ vượt trần đó." },
          { type: "p", text: "Trên trang Agent chỉ có một ô Mức truy cập: Chỉ đọc, Sửa trong workspace, hoặc Toàn quyền. Server tự chuyển thành thiết lập riêng của từng CLI: Claude dùng permission mode plan / acceptEdits / bypassPermissions, Codex dùng sandbox read-only / workspace-write / danger-full-access, agy dùng --mode plan / --mode accept-edits / --dangerously-skip-permissions." },
          { type: "p", text: "Mục Nâng cao cho chọn thiết lập riêng của CLI, nhưng chỉ được hạ xuống thấp hơn mức truy cập, không nâng lên được. Đổi mức truy cập thì mục này được đặt lại." },
          { type: "h4", text: "Agent Claude Code" },
          { type: "p", text: "Ngoài mức truy cập, agent Claude có danh sách tool được dùng: tool không chọn thì bị chặn hẳn." },
          { type: "p", text: "Trong danh sách có mục \"Tự chia việc nội bộ (cùng Claude, không giới hạn)\" — tool Task của Claude Code. Chọn thì agent tự sinh sub-agent Claude để làm song song rồi gộp kết quả; server tự thêm hướng dẫn vào system prompt, kết quả sub-agent hiện ngay trong log. Cái này không giới hạn và không qua whitelist, khác với spawn_agent: tạo agent của bất kỳ CLI nào, chỉ khai báo ở workflow kiểu Team và có giới hạn (mục 5)." },
          { type: "h4", text: "Agent Codex" },
          { type: "p", text: "Model đọc từ `~/.codex/models_cache.json`, file Codex CLI ghi lúc bạn đăng nhập. Không có danh sách tool riêng và không gắn được plugin Claude Code. Skill được ghép vào đầu prompt vì `codex exec` không có cờ system prompt. Ô cho phép truy cập mạng chỉ hiện khi agent Toàn quyền nhưng chọn sandbox workspace-write ở mục Nâng cao." },
          { type: "h4", text: "Agent Gemini (agy)" },
          { type: "p", text: "Gemini giờ chạy bằng Antigravity CLI, lệnh `agy`, thay cho lệnh `gemini` cũ. Danh sách model lấy từ `agy models` lúc server khởi động, nên khớp với những gì tài khoản của bạn dùng được." },
          { type: "p", text: "agy không có chế độ chỉ đọc thật: khi chạy nền nó cho sửa file trong thư mục làm việc và chặn lệnh shell, bất kể --mode. Vì vậy Chỉ đọc dùng --mode plan (agent lập kế hoạch thay vì sửa), kèm lời dặn trả lời trực tiếp. Sửa trong workspace thì sửa được file nhưng không chạy được lệnh. Skill được ghép vào đầu prompt như Codex." },
          { type: "p", text: "Lần đầu một agent agy cần ask_agent hoặc spawn_agent, server tự đăng ký MCP server `agent-bridge` một lần trong cấu hình agy và thêm quyền `mcp(agent-bridge/*)`. Trong phiên agy bạn tự mở, bridge không có tool nào nên không ảnh hưởng gì." },
          { type: "h4", text: "Skill riêng và xoá agent" },
          { type: "p", text: "Skill riêng là đoạn system prompt chỉ agent đó dùng. Skill dùng chung gắn từ thư viện bên tab Skills. Plugin gắn từ tab Plugins, chỉ dùng được cho agent Claude Code." },
          { type: "p", text: "Xoá agent đang nằm trong một workflow thì bị từ chối, và thông báo sẽ nêu tên workflow để bạn biết chỗ cần gỡ." },
        ],
      },
      {
        id: "skills",
        heading: "3. Skills",
        blocks: [
          { type: "p", text: "Skill là một đoạn hướng dẫn dùng lại được, ví dụ quy ước commit message hay coding style của dự án. Soạn một lần ở tab Skills rồi gắn cho bao nhiêu agent tuỳ ý." },
          { type: "p", text: "Xoá skill mà agent còn dùng cũng bị từ chối, thông báo nêu tên agent để bạn gỡ trước." },
        ],
      },
      {
        id: "plugins",
        heading: "4. Plugins",
        blocks: [
          { type: "p", text: "Đây là plugin Claude Code thật, loại có `.claude-plugin/plugin.json`, không phải bản mô phỏng. Ví dụ github.com/DietrichGebert/ponytail." },
          { type: "p", text: "Ba kiểu nguồn: repo Git (hệ thống tự clone vào server/plugins/<id>), thư mục có sẵn trên máy, hoặc URL file .zip. Gắn cho agent ở mục \"Plugin Claude Code\" trong form Agent." },
        ],
      },
      {
        id: "workflows",
        heading: "5. Workflows: Pipeline và Team",
        blocks: [
          { type: "p", text: "Khi tạo workflow, bạn chọn một trong hai kiểu. Chọn xong thì không đổi được, và editor chỉ hiện phần thuộc kiểu đó." },
          { type: "p", text: "Pipeline là sơ đồ node và cạnh: dữ liệu chảy theo cạnh, một node rẽ được ra nhiều nhánh chạy song song, nhiều nhánh gộp lại được vào một node, và router chọn một nhánh để đi tiếp. Hợp với quy trình cố định, biết trước các bước." },
          { type: "p", text: "Team là một agent điều phối cùng các thành viên có alias và vai trò. Điều phối viên nhận yêu cầu rồi tự quyết định giao việc gì cho ai, theo thứ tự nào, và có thể tạo thêm agent nếu bạn cho phép. Hợp với kiểu PM chia việc cho một nhóm." },
          { type: "h4", text: "Pipeline: tạo node và nối cạnh" },
          {
            type: "steps",
            items: [
              "Vào tab Workflows, bấm \"+ Tạo workflow mới\", chọn Pipeline.",
              "Canvas trống thì bấm \"Thêm bước đầu tiên\" để tạo node gốc.",
              "Rê chuột vào góc trên bên phải một node để hiện hai nút nhỏ: dấu \"+\" thêm node con và tự nối cạnh, dấu \"✕\" xoá node.",
              "Click vào node để mở panel bên phải. Phần trên luôn hiện: agent, loại node (Agent hoặc Router) và prompt của node.",
              "Muốn nối cạnh tới một node đã có thay vì tạo node mới thì chọn node nguồn, sang tab \"Nhánh ra\", chọn node đích trong dropdown rồi bấm \"+ Thêm nhánh\". Đây cũng là cách tạo điểm gộp nhánh.",
              "Kéo node để sắp xếp lại. Cuộn chuột để zoom, kéo nền canvas để di chuyển khung nhìn.",
            ],
          },
          { type: "p", text: "Prompt của node dùng được {{prompt}} cho yêu cầu gốc và {{previous}} cho kết quả node trước dẫn vào. Để trống thì hệ thống tự ghép. Nếu node có cạnh dẫn vào mà prompt viết tay lại không có {{previous}}, workflow sẽ không lưu được, vì kết quả của node trước sẽ bị bỏ mất." },
          { type: "h4", text: "Team: điều phối viên và thành viên" },
          {
            type: "steps",
            items: [
              "Vào tab Workflows, bấm \"+ Tạo workflow mới\", chọn Team.",
              "Ở mục Điều phối, chọn agent điều phối và viết quy trình làm việc, ví dụ: chia việc, giao code cho fe-main, gửi kết quả cho reviewer, sửa tới khi đạt rồi tổng kết. Chỉ cần mô tả quy trình. Yêu cầu của người dùng được tự thêm vào cuối, hoặc bạn tự đặt chỗ bằng {{prompt}}.",
              "Ở mục Thành viên, bấm \"+ Thêm thành viên\" cho từng người: alias dễ đọc (vd: fe-main, fe-backup, reviewer), agent, và một câu mô tả vai trò.",
              "Tuỳ chọn: bật \"Cho điều phối viên tạo agent mới khi chạy\" rồi chọn provider, model và giới hạn được phép. Agent con không bao giờ có quyền hay tool vượt quá điều phối viên. Team có thể không có thành viên nào nếu điều phối viên chỉ tự tạo agent.",
              "Bấm Lưu.",
            ],
          },
          { type: "p", text: "Lúc chạy, chỉ điều phối viên tự khởi động. Nó được giao việc cho mọi thành viên qua tool ask_agent; danh sách thành viên kèm vai trò và quy tắc workItemId đã nằm sẵn trong mô tả tool, nên không cần viết vào quy trình. Thành viên không gọi ngược lại điều phối viên. Khi được giao việc, thành viên nhận kèm mô tả vai trò của mình." },
          { type: "h4", text: "Kiểm tra khi lưu" },
          { type: "p", text: "Server kiểm tra workflow mỗi lần lưu và trả về danh sách lỗi cụ thể thay vì lặng lẽ bỏ phần sai. Ví dụ: node chỉ chạy khi được giao việc mà không ai giao việc cho nó, node như vậy lại có cạnh nối, nhánh của router thiếu nhãn hoặc trùng nhãn, luồng bị vòng lặp, prompt thiếu {{previous}} khi node có input, alias thành viên trùng hoặc sai định dạng." },
        ],
      },
      {
        id: "interaction",
        heading: "6. Ba cách agent tương tác với nhau",
        blocks: [
          { type: "p", text: "Có ba cơ chế, từ đơn giản tới linh hoạt. Chọn cái hợp với việc bạn cần, không phải dùng cả ba." },
          { type: "h4", text: "Cách 1: nối cạnh, truyền dữ liệu một chiều" },
          {
            type: "steps",
            items: [
              "Chọn node nguồn trên canvas.",
              "Bấm nút \"+\" ở góc node để tạo node con kèm cạnh, hoặc sang tab \"Nhánh ra\", chọn một node có sẵn rồi bấm \"+ Thêm nhánh\".",
              "Xong. Khi chạy, node đích khởi động ngay sau khi node nguồn xong và nhận kết quả qua {{previous}}.",
            ],
          },
          { type: "p", text: "Hợp khi thứ tự các bước cố định và biết trước. Node có nhiều cạnh ra thì các nhánh chạy song song." },
          { type: "h4", text: "Cách 2: router, chọn một nhánh" },
          {
            type: "steps",
            items: [
              "Chọn node muốn làm bộ định tuyến, thường là node có từ hai nhánh ra trở lên.",
              "Ở phần trên panel, đổi \"Loại node\" thành Router.",
              "Sang tab \"Nhánh ra\" và gõ cho mỗi nhánh một nhãn ngắn, khác nhau, ví dụ \"bug\" và \"ok\".",
              "Lưu workflow.",
            ],
          },
          { type: "p", text: "Lúc chạy, hệ thống tự thêm vào prompt của router yêu cầu kết thúc câu trả lời bằng một dòng \"ROUTE: <nhãn>\" kèm danh sách nhãn hợp lệ. Nhãn được so khớp chính xác (không phân biệt hoa thường), không còn tìm chuỗi con trong cả câu trả lời. Nhánh khớp thì chạy tiếp, các nhánh còn lại nhận badge \"Bỏ qua\". Nếu router không trả về dòng ROUTE hoặc nhãn không khớp nhánh nào, node báo lỗi chứ không đoán." },
          { type: "h4", text: "Cách 3: giao việc bằng ask_agent" },
          { type: "p", text: "Đây là cơ chế linh hoạt nhất. Node A giao việc cho node B ngay khi đang chạy, chờ nhận kết quả đầy đủ rồi mới làm tiếp, giống một PM giao việc xong thì đợi báo cáo. Thứ tự giao việc không nằm trong sơ đồ mà do agent tự quyết định lúc chạy." },
          { type: "p", text: "Kiểu Team dùng đúng cơ chế này và tự cấu hình hết: điều phối viên được giao việc cho mọi thành viên. Trong Pipeline thì bạn tự cấp quyền như sau:" },
          {
            type: "steps",
            items: [
              "Chọn node giao việc, sang tab \"Được giao việc cho\" và click chip của từng node nó được giao việc. Chip hiện cả id thật của node.",
              "Chọn từng node được giao việc, sang tab \"Kích hoạt\", tick \"Chỉ chạy khi được giao việc\". Node như vậy không được có cạnh nối, và phải có ít nhất một node được giao việc cho nó, nếu không workflow không lưu được.",
              "Viết prompt của node giao việc: giao gì cho ai, theo thứ tự nào. Danh sách node được giao việc (kèm id) và quy tắc workItemId được tự đưa vào mô tả tool, không cần chép vào prompt.",
            ],
          },
          { type: "p", text: "Cơ chế này không phân biệt CLI: node Claude, Codex và Gemini giao việc qua lại được với nhau. Mỗi lần giao việc hiện thành một task riêng trong run. Giới hạn: tối đa ba lớp gọi lồng nhau và một node không tự giao việc cho chính nó. Run luôn dùng đúng bản workflow lúc bắt đầu chạy, nên sửa workflow giữa chừng không làm thay đổi quyền giao việc của run đang chạy." },
          { type: "h4", text: "Ví dụ: PM, Frontend Engineer và Code Reviewer" },
          {
            type: "steps",
            items: [
              "Ở tab Agents tạo ba agent: Project Manager, Frontend Engineer, Code Reviewer.",
              "Ở tab Workflows tạo workflow kiểu Team. Chọn Project Manager làm điều phối viên.",
              "Thêm hai thành viên: fe-main (Frontend Engineer, \"viết code tính năng\") và reviewer (Code Reviewer, \"review code, chỉ ra lỗi\").",
              "Viết quy trình: giao việc cho fe-main và đợi code xong, gửi kết quả cho reviewer, nếu có lỗi thì giao lại fe-main sửa, cuối cùng tổng kết.",
              "Bấm Lưu, sang tab Chạy, chọn workflow vừa tạo, nhập yêu cầu rồi bấm Chạy.",
            ],
          },
          { type: "p", text: "Kết quả: PM chạy trước, giao việc cho fe-main và đợi code xong, rồi gửi reviewer và đợi nhận xét, cuối cùng viết báo cáo. Mỗi lần giao việc là một task riêng trong run, mở ra đọc được toàn bộ nội dung." },
        ],
      },
      {
        id: "run",
        heading: "7. Chạy",
        blocks: [
          { type: "p", text: "Có hai chế độ. \"Workflow\" chạy một workflow đã soạn. \"1 Agent\" chạy một agent đơn, và bạn có thể bật \"Tự chia nhỏ thành nhiều subagent\" để AI tự phân rã yêu cầu lớn." },
          { type: "p", text: "Chọn workflow xong thì sơ đồ hiện ngay bên phải để xem trước. Lúc chạy, sơ đồ đổi màu theo trạng thái từng node: xám là chờ, vàng nhấp nháy là đang chạy, xanh là xong, đỏ là lỗi, mờ nét đứt là bị bỏ qua." },
          { type: "p", text: "Thư mục làm việc gõ tay được, hoặc bấm \"Duyệt...\" để mở trình duyệt thư mục đọc thẳng từ ổ đĩa, không cần dialog của hệ điều hành." },
          { type: "h4", text: "Lịch sử run" },
          { type: "p", text: "Chuyển sang tab khác không làm dừng run. Workflow chạy ở phía server, không phụ thuộc việc bạn có mở trang Chạy hay không. Quay lại rồi click vào run trong danh sách là xem tiếp được log, và vẫn theo dõi realtime nếu nó chưa xong." },
          { type: "p", text: "Lịch sử được ghi ra file nên không mất khi restart server. Nếu server tắt hoặc crash đúng lúc một run đang dở thì lần khởi động sau sẽ đánh dấu run đó là lỗi kèm giải thích, phần log đã có tới lúc đó vẫn giữ nguyên." },
          { type: "p", text: "Xoá từng run bằng nút thùng rác hiện khi rê chuột, hoặc \"Xoá tất cả\" ở đầu danh sách. Cả hai đều hỏi lại và đều không cho xoá run đang chạy. Riêng \"Xoá tất cả\" thì bỏ qua run đang chạy chứ không báo lỗi cả loạt." },
          { type: "h4", text: "Chat tiếp sau khi chạy" },
          { type: "p", text: "Run chạy xong có ô chat ở dưới danh sách task. Tin nhắn gửi tới agent chính của run: agent của run đơn lẻ, điều phối viên của Team (vẫn giao việc cho thành viên và tạo agent được như trước), hoặc bước Pipeline chạy xong sau cùng. Mỗi tin nhắn hiện thành một task \"Chat tiếp\" trong cùng run." },
          { type: "p", text: "Agent giữ nguyên ngữ cảnh: Claude và agy mở lại đúng phiên làm việc trước của chúng. Nếu không mở lại được (hoặc với Codex), tin nhắn được gửi kèm lịch sử cuộc trò chuyện. Thay đổi đang chờ Accept/Decline không chặn chat: lượt mới sửa tiếp trên chính code chưa accept đó, và review sau lượt đó gộp tất cả các lượt — Accept một lần là nhận hết." },
          { type: "p", text: "Ô chat nằm cạnh sơ đồ của run, trong một khung luôn hiện khi bạn cuộn danh sách task. Khi agent đang làm việc, ô chat có nút Dừng. Mỗi lượt chat có nút xoá, và có nút xoá toàn bộ chat; xoá lượt nào thì xoá luôn các task giao việc / tạo agent của lượt đó, và agent cũng quên lượt đó. Xoá chat không hoàn tác code đã Accept." },
          { type: "h4", text: "Dừng giữa chừng và chạy tiếp" },
          { type: "p", text: "Run đang chạy có nút \"Dừng\" nằm ngay cạnh badge trạng thái. Bấm vào thì server kết thúc cả cây tiến trình của CLI đang chạy, không chỉ mỗi tiến trình cha: `claude` và `codex` đều chạy qua shim của npm và tự sinh thêm tiến trình con cho từng tool chúng gọi, nên giết mỗi tiến trình cha sẽ để lại cả nhánh con vẫn đang sửa file cho một run mà bạn vừa dừng. Đồng thời workflow cũng ngừng phát các bước chưa chạy." },
          { type: "p", text: "Dừng không phải là lỗi. Run và các bước bị ngắt hiện trạng thái \"Đã dừng\" bằng màu xám chứ không phải đỏ, và kết quả của những bước đã xong trước đó vẫn được giữ nguyên." },
          { type: "p", text: "Sau mỗi bước hoàn tất, hệ thống ghi checkpoint gồm trạng thái và kết quả của từng node vào lịch sử run. Nhờ vậy, run nào bị dừng, bị lỗi, hoặc dở dang lúc server sập đều hiện thêm nút \"Chạy tiếp\". Bấm vào thì các bước đã xong giữ nguyên kết quả và không chạy lại, chỉ những bước chưa xong mới chạy. Bước đang chạy dở lúc bị ngắt được coi là chưa xong nên sẽ chạy lại từ đầu, vì không có cách nào biết nó đã làm tới đâu." },
          { type: "p", text: "Log của lần chạy trước không bị xoá. Lần chạy mới thêm task của nó vào cuối danh sách, nên bạn đọc được cả hai lần, còn sơ đồ thì hiển thị theo lần chạy gần nhất của mỗi node. Đầu lần chạy tiếp có một dòng ghi rõ những bước nào được bỏ qua vì đã xong." },
          { type: "p", text: "Chỉ run theo workflow mới chạy tiếp được, vì checkpoint tính theo node của đồ thị. Run chế độ 1 Agent thì dừng được nhưng không chạy tiếp được." },
          { type: "h4", text: "Chọn nhánh git đích" },
          { type: "p", text: "Form Chạy có ô \"Nhánh git đích\", lấy từ các nhánh của repo chứa thư mục làm việc. Chọn một nhánh có sẵn, hoặc tick \"Tạo nhánh mới cho run này\" và đặt tên — nhánh mới được tạo từ nhánh đã chọn ngay khi bấm chạy. Mặc định là nhánh đang checkout." },
          { type: "p", text: "Agent làm việc trên bản sao tách từ nhánh đích; bấm Accept thì code được gộp vào đúng nhánh đó. Nếu nhánh đích không phải nhánh đang checkout, repo của bạn vẫn đứng yên ở nhánh hiện tại (kể cả thay đổi chưa commit). Các lượt chat tiếp và chạy tiếp cũng gộp vào cùng nhánh." },
          { type: "h4", text: "Review thay đổi bằng git worktree" },
          { type: "p", text: "Mọi run trên git repository đều làm việc trong một nhánh review riêng, kể cả chế độ 1 Agent và workflow tuyến tính. Nhánh đang checkout không đổi trong lúc agent chạy. Với workflow, mỗi node còn có worktree riêng để các nhánh song song không ghi đè lẫn nhau." },
          { type: "p", text: "Khi run kết thúc, trang Run hiển thị danh sách file và unified diff. Accept mới merge nhánh review vào nhánh gốc; Decline xoá nhánh review nên toàn bộ thay đổi của run bị loại bỏ. Nếu workflow có cấu hình lệnh test, từng node vẫn phải qua test trước khi được đưa vào bản review." },
          { type: "p", text: "Toàn bộ quá trình này ghi vào một task riêng tên \"Không gian làm việc\" trong run, còn phần commit, kiểm thử và gộp thì nằm trong log của chính node tương ứng." },
          { type: "p", text: "Review an toàn yêu cầu git repository sạch. Hãy commit hoặc stash phần đang làm dở trước khi chạy; hệ thống dừng trước khi gọi agent nếu repo bẩn hoặc không tạo được worktree review. Nếu thư mục làm việc không phải git repository thì không có gì để review: run vẫn chạy bình thường ngay trên thư mục đó, và trang Run ghi rõ lý do không có bản review." },
          { type: "p", text: "Worktree chỉ chứa file git quản lý, nên các mục cấp cao nhất bị .gitignore (node_modules, .env, build cache...) được liên kết dùng chung với repo gốc — agent vẫn chạy được lệnh test hay đọc biến môi trường mà không phải cài lại. Đổi lại, những thứ này KHÔNG được cách ly: hai bước song song cùng chạy npm install vẫn ghi vào chung một node_modules." },
        ],
      },
      {
        id: "limits",
        heading: "8. Giới hạn hiện tại",
        blocks: [
          { type: "p", text: "Dừng là dừng cứng, không có kiểu xin agent kết thúc tử tế trước. Trên Windows lại càng cứng, vì cơ chế diệt cây tiến trình ở đó dựa trên `taskkill /T /F` nên không có bản nhẹ tay hơn để chọn. Agent đang sửa file dở lúc bị dừng thì file nằm nguyên ở trạng thái dở đó." },
          { type: "p", text: "Chạy tiếp làm lại nguyên bước bị ngắt chứ không nối tiếp phần việc dở của bước đó, vì checkpoint chỉ ghi tới mức từng node, không ghi được agent đã làm tới đâu bên trong một node." },
          { type: "p", text: "Codex không gắn được plugin của Claude Code. Plugin của Codex đến từ marketplace riêng của nó với định dạng khác hẳn, nên thư mục plugin bạn cài ở tab Plugins không dùng lại cho Codex được." },
          { type: "p", text: "Codex cũng không có allow/deny từng tool cho các tool của chính nó. Bảng `[tools]` trong cấu hình Codex chỉ có vài công tắc lẻ (web_search và tương tự), không có danh sách bật/tắt tổng quát, nên quyền đụng shell và file của node Codex chỉ do Sandbox quyết định." },
          { type: "p", text: "Sub-agent được sinh bên trong một tiến trình CLI dùng chung review worktree với agent cha. Chúng vẫn cách ly khỏi nhánh gốc, nhưng diff cuối không thể tách riêng thay đổi theo từng sub-agent." },
          { type: "p", text: "Xung đột khi gộp nhánh thì hệ thống không tự giải quyết, nó huỷ merge để nhánh gốc nguyên vẹn rồi để bạn tự xử lý bằng tay trên nhánh tạm còn giữ lại." },
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
          { type: "p", text: "Everything runs on your own machine. You type a request, the server spawns a real CLI process per agent: `claude -p` for Claude Code, `codex exec` for Codex, `agy --print` for Gemini. There's nowhere to paste an API key because none is needed. Each process just uses the CLI session you're already signed into." },
          { type: "p", text: "There are 4 things to configure. Agents are who does the work and which CLI runs them, Skills are shared knowledge, Plugins are real Claude Code plugins, and Workflows are how several agents work together. The Run tab starts things and shows progress. Run history is written to disk, so it survives a server restart." },
        ],
      },
      {
        id: "agents",
        heading: "2. Agents",
        blocks: [
          { type: "p", text: "The most important field is which CLI runs the agent: Claude Code, Codex or Gemini (the agy command). The rest of the form changes to match. A CLI that isn't installed is greyed out in the dropdown with a warning." },
          { type: "h4", text: "Each permission is declared in one place" },
          { type: "p", text: "The agent says what it may do on its own — that's its ceiling. A workflow says whom it may hand work to and whom it may create, and never goes above that ceiling." },
          { type: "p", text: "The agent page has a single Access level: Read-only, Edit the workspace, or Full access. The server turns it into each CLI's own setting: Claude's permission mode plan / acceptEdits / bypassPermissions, Codex's sandbox read-only / workspace-write / danger-full-access, and agy's --mode plan / --mode accept-edits / --dangerously-skip-permissions." },
          { type: "p", text: "Advanced lets you pick the CLI's own setting, but only below the access level, never above it. Changing the access level resets it." },
          { type: "h4", text: "Claude Code agents" },
          { type: "p", text: "Besides the access level, a Claude agent has a list of tools it may use: any tool you don't pick is blocked outright." },
          { type: "p", text: "One entry is \"Split work internally (Claude only, unlimited)\" — Claude Code's Task tool. Pick it and the agent creates its own Claude sub-agents to work in parallel and merges the results; the server adds guidance to the system prompt, and sub-agent output shows up in the step's log. It's unlimited and not whitelisted, unlike spawn_agent, which creates agents of any CLI, is declared only on a Team workflow, and has limits (section 5)." },
          { type: "h4", text: "Codex agents" },
          { type: "p", text: "The model list is read from `~/.codex/models_cache.json`, which the Codex CLI writes when you log in. There's no per-tool list and no Claude Code plugins. Skills are prepended to the prompt because `codex exec` has no system-prompt flag. The network access checkbox only appears for a full-access agent that picked the workspace-write sandbox under Advanced." },
          { type: "h4", text: "Gemini agents (agy)" },
          { type: "p", text: "Gemini now runs through the Antigravity CLI, the `agy` command, which replaced the old `gemini` command. The model list comes from `agy models` when the server starts, so it matches what your account can use." },
          { type: "p", text: "agy has no true read-only mode: in a background run it lets file edits in the working folder through and refuses shell commands, whatever --mode says. So Read-only uses --mode plan (the agent plans instead of editing) and tells it to answer directly. Edit the workspace can edit files but can't run commands. Skills are prepended to the prompt as with Codex." },
          { type: "p", text: "The first time an agy agent needs ask_agent or spawn_agent, the server registers an MCP server called `agent-bridge` in agy's config once and adds the permission `mcp(agent-bridge/*)`. In agy sessions you start yourself the bridge has no tools, so it changes nothing." },
          { type: "h4", text: "Private skill and deleting an agent" },
          { type: "p", text: "A private skill is a system-prompt snippet only that agent uses. Shared skills are attached from the Skills tab library. Plugins come from the Plugins tab and only work for Claude Code agents." },
          { type: "p", text: "Deleting an agent that's still used in a workflow is refused, and the message names the workflow so you know where to remove it." },
        ],
      },
      {
        id: "skills",
        heading: "3. Skills",
        blocks: [
          { type: "p", text: "A skill is a reusable block of instructions, like commit message conventions or a project's coding style. Write it once in the Skills tab and attach it to as many agents as you want." },
          { type: "p", text: "Deleting a skill that agents still use is refused too, and the message names them so you can detach it first." },
        ],
      },
      {
        id: "plugins",
        heading: "4. Plugins",
        blocks: [
          { type: "p", text: "These are real Claude Code plugins, the kind with a `.claude-plugin/plugin.json`, not a reimplementation. For example github.com/DietrichGebert/ponytail." },
          { type: "p", text: "Three source types: a Git repo (cloned into server/plugins/<id> for you), a directory you already have locally, or a `.zip` URL. Attach one to an agent under \"Claude Code plugin\" in the Agent form." },
        ],
      },
      {
        id: "workflows",
        heading: "5. Workflows: Pipeline and Team",
        blocks: [
          { type: "p", text: "When you create a workflow you pick one of two types. It can't be changed afterwards, and the editor only shows what belongs to that type." },
          { type: "p", text: "A Pipeline is a graph of nodes and edges: data flows along edges, a node can fan out into parallel branches, branches can merge back into one node, and a router picks one branch to continue. Best for a fixed process with known steps." },
          { type: "p", text: "A Team is one coordinator agent plus members with an alias and a role. The coordinator takes the request and decides who does what, in which order, and can create extra agents if you allow it. Best for a PM handing work to a group." },
          { type: "h4", text: "Pipeline: creating nodes and edges" },
          {
            type: "steps",
            items: [
              "In the Workflows tab click \"+ New workflow\" and pick Pipeline.",
              "On an empty canvas click \"Add first step\" to create the root node.",
              "Hover a node's top-right corner for two small buttons: \"+\" adds a child node with an edge, \"✕\" deletes the node.",
              "Click a node to open the panel on the right. The top part is always visible: agent, node type (Agent or Router) and the node's prompt.",
              "To connect to an existing node instead of a new one, select the source, open the \"Branches\" tab, pick the target in the dropdown and click \"+ Add branch\". That's also how you build a merge point.",
              "Drag nodes to rearrange them. Scroll to zoom, drag the background to pan.",
            ],
          },
          { type: "p", text: "A node's prompt can use {{prompt}} for the original request and {{previous}} for the output of the nodes feeding into it. Leave it empty and the system assembles the prompt itself. If a node has incoming edges but a hand-written prompt without {{previous}}, the workflow won't save, because the earlier output would be lost." },
          { type: "h4", text: "Team: coordinator and members" },
          {
            type: "steps",
            items: [
              "In the Workflows tab click \"+ New workflow\" and pick Team.",
              "Under Coordinator, choose the coordinator agent and describe how the team works, e.g. split the work, give coding to fe-main, send the result to reviewer, iterate until it passes, then summarize. Describe the process only: the user's request is appended automatically, or place it yourself with {{prompt}}.",
              "Under Members, click \"+ Add member\" for each one: a readable alias (e.g. fe-main, fe-backup, reviewer), an agent, and a one-line role.",
              "Optional: turn on \"Let the coordinator create new agents\" and choose the allowed providers, models and limits. A spawned agent never gets more access or tools than the coordinator itself. A Team may have no members at all if the coordinator only spawns.",
              "Click Save.",
            ],
          },
          { type: "p", text: "At run time only the coordinator starts on its own. It can hand work to every member through the ask_agent tool; the member list with roles and the workItemId rules are already in the tool description, so the process doesn't need to repeat them. Members don't call the coordinator back. A member handed work also receives its own role description." },
          { type: "h4", text: "Checks on save" },
          { type: "p", text: "The server checks the workflow on every save and returns a list of specific problems instead of quietly dropping what doesn't fit. For example: a node that only runs when handed work but nobody hands it work, such a node wired with edges, a router branch with a missing or duplicate label, a loop in the flow, a prompt without {{previous}} on a node that has input, or a duplicate or malformed member alias." },
        ],
      },
      {
        id: "interaction",
        heading: "6. Three ways agents work together",
        blocks: [
          { type: "p", text: "There are three mechanisms, from simple to flexible. Use whichever fits; you don't need all three." },
          { type: "h4", text: "1. Edges, one-way data flow" },
          {
            type: "steps",
            items: [
              "Select the source node on the canvas.",
              "Click the \"+\" on its corner to add a child node with an edge, or open \"Branches\", pick an existing node and click \"+ Add branch\".",
              "Done. At run time the target starts right after the source finishes and gets its output through {{previous}}.",
            ],
          },
          { type: "p", text: "Use it when the order of steps is fixed and known. A node with several outgoing edges runs those branches in parallel." },
          { type: "h4", text: "2. Router, pick one branch" },
          {
            type: "steps",
            items: [
              "Select the node that should decide, usually one with two or more outgoing branches.",
              "In the top part of the panel, set \"Node type\" to Router.",
              "Open \"Branches\" and give each branch a short, distinct label, e.g. \"bug\" and \"ok\".",
              "Save the workflow.",
            ],
          },
          { type: "p", text: "At run time the router's prompt automatically asks it to end with one line \"ROUTE: <label>\" and lists the valid labels. The label is matched exactly (case-insensitive) — the answer is no longer searched for substrings. The matching branch continues and the others are marked \"Skipped\". If the router gives no ROUTE line or names no real branch, the node fails rather than guess." },
          { type: "h4", text: "3. Handing work over with ask_agent" },
          { type: "p", text: "The most flexible mechanism. Node A hands work to node B mid-run, waits for the full result, then carries on — like a PM assigning a task and waiting for the report. The order isn't in the diagram; the agent decides at run time." },
          { type: "p", text: "The Team type uses exactly this and sets it up for you: the coordinator can hand work to every member. In a Pipeline you grant it yourself:" },
          {
            type: "steps",
            items: [
              "Select the node that hands out work, open \"Can hand work to\" and click the chip of each node it may use. Chips show the node's real id.",
              "Select each node that receives work, open \"Trigger\" and tick \"Only runs when handed work\". Such a node can't have edges, and at least one node must be able to hand it work, or the workflow won't save.",
              "Write the handing-out node's prompt: what goes to whom, in which order. The list of nodes (with ids) and the workItemId rules go into the tool description automatically.",
            ],
          },
          { type: "p", text: "It doesn't care which CLI is on either end: Claude, Codex and Gemini nodes can hand work to each other. Every hand-off shows up as its own task in the run. Limits: at most three levels of nesting, and a node can't hand work to itself. A run always uses the workflow as it was when the run started, so editing the workflow mid-run doesn't change who may hand work to whom in that run." },
          { type: "h4", text: "Worked example: PM, Frontend Engineer and Code Reviewer" },
          {
            type: "steps",
            items: [
              "In the Agents tab create three agents: Project Manager, Frontend Engineer, Code Reviewer.",
              "In the Workflows tab create a Team workflow and make Project Manager the coordinator.",
              "Add two members: fe-main (Frontend Engineer, \"writes the feature code\") and reviewer (Code Reviewer, \"reviews the code and points out problems\").",
              "Describe the process: give the work to fe-main and wait for the code, send the result to reviewer, send fixes back to fe-main if needed, then summarize.",
              "Save, go to the Run tab, pick the workflow, type a request and click Run.",
            ],
          },
          { type: "p", text: "Result: the PM runs first, hands the work to fe-main and waits for the code, sends it to reviewer and waits for the review, then writes the final report. Each hand-off is its own task in the run, with the full exchange readable." },
        ],
      },
      {
        id: "run",
        heading: "7. Running things",
        blocks: [
          { type: "p", text: "Two modes. \"Workflow\" runs one you've built. \"1 Agent\" runs a single agent, and you can switch on \"Auto-decompose into sub-agents\" to have the AI break a large request up itself." },
          { type: "p", text: "Pick a workflow and its diagram appears on the right as a preview. While it runs the diagram colours per node: grey is pending, pulsing amber is running, green is done, red is an error, dim and dashed means skipped." },
          { type: "p", text: "You can type the working directory or click \"Browse...\" for an in-app folder browser that reads straight from disk, no OS dialog involved." },
          { type: "h4", text: "Run history" },
          { type: "p", text: "Switching tabs doesn't stop a run. It executes on the server and doesn't care whether the Run page is open. Come back, click the run in the list, and you pick the log back up, still live if it hasn't finished." },
          { type: "p", text: "History is written to disk, so a restart doesn't lose it. If the server is killed or crashes while a run is going, the next startup marks it as an error with a note explaining why, and keeps whatever it had logged." },
          { type: "p", text: "Delete runs one at a time with the trash icon that appears on hover, or clear the whole list from the header. Both ask first, and neither will delete a run that's still going. Clear-all skips those rather than failing outright." },
          { type: "h4", text: "Continuing the chat after a run" },
          { type: "p", text: "A finished run has a chat box under its tasks. The message goes to the run's lead agent: the agent of a single-agent run, a Team's coordinator (which can still hand work to members and spawn agents), or the Pipeline step that finished last. Each message shows up as a \"Follow-up\" task in the same run." },
          { type: "p", text: "The agent keeps its context: Claude and agy pick their previous session back up. If that isn't possible (or for Codex), the message is sent with the conversation so far attached. Changes waiting for Accept/Decline don't block the chat: the next turn keeps editing that unaccepted code, and the review after it covers every turn — one Accept takes them all." },
          { type: "p", text: "The chat box sits next to the run's diagram in a panel that stays in view while you scroll the tasks. While the agent works it shows a Stop button. Each chat turn can be deleted, or the whole chat cleared; a deleted turn takes its hand-offs and spawned agents with it, and the agent forgets it. Deleting doesn't undo code changes." },
          { type: "h4", text: "Stopping and resuming" },
          { type: "p", text: "A running run has a \"Stop\" button next to its status badge. Click it and the server kills the running CLI's entire process tree, not just the top process: `claude` and `codex` both run through an npm shim and spawn further processes for the tools they call, so killing only the parent would leave that whole subtree still editing files for a run you just stopped. The workflow also stops handing out steps that haven't started." },
          { type: "p", text: "Stopping isn't a failure. The run and its interrupted steps show as \"Stopped\" in grey rather than error red, and whatever earlier steps produced is kept." },
          { type: "p", text: "After each step finishes, the system checkpoints that node's status and result into the run history. So any run that was stopped, failed, or was mid-flight when the server died also gets a \"Resume\" button. Steps that already finished keep their results and aren't run again; only unfinished ones run. A step that was in flight when it was interrupted counts as unfinished and starts over, since there's no way to know how far it got." },
          { type: "p", text: "The previous attempt's log isn't discarded. The new attempt appends its own tasks at the end, so you can read both, while the diagram reflects each node's most recent attempt. A line at the start of the resumed attempt spells out which steps were skipped as already done." },
          { type: "p", text: "Only workflow runs can be resumed, since the checkpoint is per graph node. A 1 Agent run can be stopped but not resumed." },
          { type: "h4", text: "Picking the target branch" },
          { type: "p", text: "The Run form has a \"Target git branch\" field listing the branches of the repo your working directory is in. Pick an existing branch, or tick \"Create a new branch for this run\" and name it — it's created from the picked branch when you start the run. The default is the checked-out branch." },
          { type: "p", text: "The agent works on a copy forked from the target branch, and Accept merges the code into that branch. If it isn't the checked-out branch, your repo stays where it is, uncommitted changes included. Chat turns and resumes land on the same branch." },
          { type: "h4", text: "Change review with git worktrees" },
          { type: "p", text: "Every run targeting a git repository works on a dedicated review branch, including 1 Agent runs and linear workflows. The checked-out base branch remains unchanged while agents work. Workflow nodes also receive separate worktrees so parallel branches cannot overwrite each other." },
          { type: "p", text: "When the run finishes, the Run page shows every changed file and its unified diff. Accept merges the review branch into the base branch; Decline deletes it and discards the run's changes. A configured workflow test command still gates each node before its work enters the review." },
          { type: "p", text: "The whole process is logged to a separate \"Workspace\" task in the run, while the commit, test and merge for each branch go into that node's own log." },
          { type: "p", text: "Safe review requires a clean git repository. Commit or stash work in progress before running; the system stops before invoking an agent if the repo is dirty or the review worktree cannot be created. If the working directory isn't a git repository at all there is nothing to review against, so the run simply proceeds in that directory and the Run page records why no review was produced." },
          { type: "p", text: "A worktree only holds git-tracked files, so top-level .gitignore'd entries (node_modules, .env, build caches...) are linked through to the base repo — an agent can still run your tests or read environment variables without reinstalling anything. The trade-off is that those are NOT isolated: two parallel steps both running npm install still write into the same node_modules." },
        ],
      },
      {
        id: "limits",
        heading: "8. Current limitations",
        blocks: [
          { type: "p", text: "Stopping is abrupt, with no graceful \"please wrap up\" asked of the agent first. On Windows it's more abrupt still, since tree killing there goes through `taskkill /T /F` and there's no gentler variant to offer. An agent halfway through editing a file when you stop it leaves that file halfway edited." },
          { type: "p", text: "Resume re-runs the whole interrupted step rather than picking up inside it, because the checkpoint only goes down to the node level and can't record how far an agent got within one." },
          { type: "p", text: "Claude Code plugins can't be attached to Codex agents. Codex plugins come from its own marketplaces in a different format, so a plugin directory installed on the Plugins tab has nothing to offer a Codex node." },
          { type: "p", text: "Codex also has no per-tool allow or deny for its own tools. Its `[tools]` config table has only a few named switches (web_search and similar) with no general enable/disable list, so a Codex node's access to the shell and filesystem is decided by the Sandbox setting alone." },
          { type: "p", text: "Sub-agents spawned inside one CLI process share their parent's review worktree. They remain isolated from the base branch, but their edits cannot be attributed separately in the final diff." },
          { type: "p", text: "Merge conflicts aren't resolved automatically. The merge is aborted so the base branch is left untouched, and you sort it out by hand on the temp branch that's kept for you." },
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
