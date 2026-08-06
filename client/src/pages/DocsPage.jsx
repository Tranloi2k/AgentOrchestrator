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
          { type: "p", text: "Hệ thống chạy hoàn toàn ở máy bạn. Bạn gõ một yêu cầu, server sinh ra tiến trình CLI thật cho từng agent: `claude -p` nếu agent đó dùng Claude Code, `codex exec` nếu dùng Codex. Không có chỗ nào nhập API key vì không cần, mỗi tiến trình dùng luôn phiên đăng nhập CLI sẵn có trên máy." },
          { type: "p", text: "Có 4 phần cấu hình. Agents là ai làm việc và chạy bằng CLI nào, Skills là kiến thức dùng chung, Plugins là plugin Claude Code thật, Workflows là cách nhiều agent phối hợp. Tab Chạy để khởi động và theo dõi tiến trình. Lịch sử run được ghi ra file nên không mất khi restart server." },
        ],
      },
      {
        id: "agents",
        heading: "2. Agents",
        blocks: [
          { type: "p", text: "Trường quan trọng nhất khi tạo agent là \"CLI thực thi\": chọn Claude Code hay Codex. Chọn xong thì phần còn lại của form đổi theo, vì hai CLI hỗ trợ khác nhau. CLI nào chưa cài trên máy sẽ bị mờ trong dropdown kèm cảnh báo, để bạn không tạo nhầm agent chắc chắn chạy lỗi." },
          { type: "h4", text: "Agent Claude Code" },
          { type: "p", text: "Bạn chọn model, permission mode, và hai danh sách tool được phép hoặc bị cấm. Bật \"Chỉ đọc\" thì hệ thống tự đặt plan mode và chặn Edit/Write, tiện khi làm agent review." },
          { type: "p", text: "Trong danh sách tool có một mục đáng chú ý là \"Tạo sub-agent\". Tick vào thì agent được phép tự sinh sub-agent để làm song song vài phần việc rồi gộp kết quả lại. Tick là xong, không phải viết thêm gì trong prompt: khi tool này bật, server tự thêm phần hướng dẫn vào system prompt, agent tự cân nhắc lúc nào nên tách việc. Kết quả của sub-agent hiện ngay trong log của bước đó." },
          { type: "p", text: "Cái này khác với \"Gọi 2 chiều\" ở mục 6. Sub-agent ở đây là agent tạm kiểu chung chung, do chính agent sinh ra lúc chạy. Còn ask_agent là gọi đúng một agent bạn đã cấu hình sẵn, với model, skill và tool riêng của nó." },
          { type: "h4", text: "Agent Codex" },
          { type: "p", text: "Model là dropdown đọc từ `~/.codex/models_cache.json`, file mà Codex CLI ghi lúc bạn đăng nhập. Nhờ vậy danh sách luôn khớp với model tài khoản bạn thật sự dùng được, không phải danh sách cứng viết sẵn rồi lỗi thời." },
          { type: "p", text: "Quyền hạn của Codex ít hơn Claude vì `codex exec` chỉ hỗ trợ đến vậy. Bạn có Sandbox (`read-only`, `workspace-write`, `danger-full-access`) và một checkbox cho phép truy cập mạng, checkbox này chỉ có tác dụng khi sandbox là `workspace-write`. Không có allow/deny từng tool và không gắn được plugin của Claude Code." },
          { type: "p", text: "Bù lại, ask_agent thì Codex dùng được đầy đủ như Claude: gọi node khác và bị node khác gọi, kể cả gọi chéo giữa hai loại CLI. Skill riêng và skill dùng chung cũng áp dụng cho Codex — do `codex exec` không có cờ system prompt nên nội dung skill được ghép vào đầu prompt." },
          { type: "p", text: "Nút \"Chỉ đọc\" đặt mặc định an toàn cho cả hai loại: Claude thì plan mode và chặn Edit/Write, Codex thì sandbox read-only." },
          { type: "h4", text: "Skill riêng và xoá agent" },
          { type: "p", text: "Skill riêng là đoạn system prompt chỉ agent đó dùng. Với Codex thì nội dung này được chèn vào đầu prompt, vì Codex không có cờ `--append-system-prompt`. Skill dùng chung thì gắn từ thư viện bên tab Skills." },
          { type: "p", text: "Plugin gắn từ tab Plugins, chỉ dùng được cho agent Claude Code, chạy kèm `--plugin-dir` hoặc `--plugin-url`." },
          { type: "p", text: "Xoá agent đang nằm trong một workflow thì bị từ chối, và thông báo sẽ nêu tên workflow để bạn biết chỗ cần gỡ. Mọi thao tác xoá đều hỏi lại qua popup của app chứ không dùng hộp thoại mặc định của trình duyệt." },
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
        heading: "5. Workflows: sơ đồ nhiều agent",
        blocks: [
          { type: "p", text: "Workflow là đồ thị gồm node và cạnh, không chỉ là chuỗi thẳng. Một node có thể rẽ ra nhiều nhánh chạy song song, và nhiều nhánh cũng có thể gộp lại vào chung một node." },
          { type: "h4", text: "Tạo node và nối cạnh" },
          {
            type: "steps",
            items: [
              "Vào tab Workflows, bấm \"+ Tạo workflow mới\", hoặc bấm \"Sửa\" trên workflow có sẵn.",
              "Canvas trống thì bấm \"Thêm bước đầu tiên\" để tạo node gốc.",
              "Rê chuột vào góc trên bên phải một node để hiện hai nút nhỏ: dấu \"+\" thêm node con và tự nối cạnh, dấu \"✕\" xoá node.",
              "Click vào node để chọn, panel sửa hiện bên phải. Mục \"General\" luôn hiện, cho bạn chọn agent và viết prompt cho node đó.",
              "Muốn nối cạnh tới một node đã có sẵn thay vì tạo node mới thì chọn node nguồn, sang tab \"Branches\", chọn tên agent đích trong dropdown rồi bấm \"+ Thêm nhánh\". Đây cũng là cách tạo điểm gộp nhánh.",
              "Kéo node để sắp xếp lại vị trí, giữ chuột và kéo chứ không phải click. Cuộn chuột để zoom, kéo nền canvas để di chuyển khung nhìn.",
            ],
          },
          { type: "p", text: "Prompt của node dùng được {{prompt}} cho yêu cầu gốc và {{previous}} cho kết quả node trước dẫn vào. Để trống thì hệ thống tự ghép." },
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
              "Bấm nút \"+\" ở góc node để tạo node con kèm cạnh. Hoặc sang tab \"Branches\", chọn một node có sẵn trong dropdown rồi bấm \"+ Thêm nhánh\".",
              "Xong, không cần cấu hình gì thêm. Khi chạy, node đích khởi động ngay sau khi node nguồn xong và nhận kết quả qua {{previous}}.",
            ],
          },
          { type: "p", text: "Hợp với trường hợp thứ tự các bước cố định và biết trước, không cần quyết định gì. Xong bước này thì chạy bước kia, hoặc chạy song song nếu node có nhiều cạnh ra." },

          { type: "h4", text: "Cách 2: router, rẽ nhánh theo điều kiện" },
          {
            type: "steps",
            items: [
              "Chọn node muốn làm bộ định tuyến, thường là node đã có từ hai nhánh ra trở lên.",
              "Panel bên phải, tab \"Trigger\", tick ô Router.",
              "Sang tab \"Branches\". Mỗi nhánh giờ có thêm ô \"condition\", chỉ hiện khi node là router. Gõ một từ khoá ngắn, ví dụ \"bug\" hoặc \"ok\".",
              "Lưu workflow.",
            ],
          },
          { type: "p", text: "Lúc chạy, hệ thống so câu trả lời của node router với từng từ khoá, không phân biệt hoa thường. Nhánh khớp thì chạy tiếp, các nhánh còn lại nhận badge \"Bỏ qua\" và không tốn gì cả." },
          { type: "p", text: "Hợp khi cần rẽ theo kết quả. Ví dụ node kiểm tra thấy có bug thì rẽ sang node sửa lỗi, không thì rẽ sang node viết tài liệu." },

          { type: "h4", text: "Cách 3: gọi 2 chiều bằng ask_agent" },
          { type: "p", text: "Đây là cơ chế linh hoạt nhất. Node A có thể hỏi node B ngay khi đang chạy dở, chờ nhận câu trả lời đầy đủ rồi mới làm tiếp, giống một PM giao việc xong thì đợi báo cáo trước khi giao việc kế. Thứ tự gọi không nằm trong sơ đồ mà do chính agent quyết định lúc chạy, dựa trên prompt bạn viết." },
          { type: "p", text: "Cơ chế này không phân biệt CLI. Cầu nối là một MCP server stdio bình thường, cả `claude` lẫn `codex` chạy đúng cùng một tiến trình đó, chỉ khác cách truyền tham số vào. Nên node Codex gọi được node Claude, node Claude gọi được node Codex, và cùng loại gọi nhau cũng được — vẫn dùng đúng id node trên canvas, đúng danh sách cho phép gọi của từng node, và cùng giới hạn độ sâu chống gọi vòng." },
          {
            type: "steps",
            items: [
              "Chọn node đóng vai người gọi, ví dụ node Project Manager.",
              "Panel bên phải, tab \"Gọi 2 chiều\".",
              "Click vào chip của từng node mà node này được phép gọi. Chip đổi màu khi chọn và hiện luôn id thật của node, dạng `nextjs-frontend-engineer · id=\"nwvl6e3\"`. Chọn được nhiều node.",
              "Sang tab \"General\" sửa prompt của node gọi cho rõ: gọi ai trước, gọi ai sau, gửi gì cho từng bên. Phần cấu hình chỉ cấp quyền gọi, còn thứ tự và nội dung thì agent tự xoay theo prompt này.",
              "Nên làm thêm bước này: chọn từng node bị gọi, sang tab \"Trigger\", tick \"Chỉ chạy khi được gọi trực tiếp\". Không có nó thì node bị gọi vừa tự chạy theo sơ đồ vừa bị gọi lại, thành ra chạy hai lần.",
              "Không cần nối cạnh giữa các node dùng cơ chế này. Quan hệ gọi độc lập hoàn toàn với cạnh dữ liệu, trên sơ đồ nó hiện thành đường nét đứt màu tím có mũi tên.",
            ],
          },
          { type: "p", text: "Về id: mỗi node có id riêng, hiện ở ba chỗ. Trên sơ đồ ngay dưới tên node, ở ô \"Id của bước này\" trong tab General, và trên chip ở tab \"Gọi 2 chiều\". Đây là id để gọi qua ask_agent, khác với id của agent bên tab Agents. Thật ra bạn không bắt buộc phải chép id vào prompt, chỉ cần nhắc tên agent là model tự tìm đúng, vì danh sách node được phép gọi kèm id đã nằm sẵn trong phần mô tả của tool lúc chạy. Nhưng ghi thẳng id vào prompt vẫn chắc ăn hơn khi dùng model nhỏ, tránh nhầm giữa các node tên gần giống nhau." },
          { type: "p", text: "Vài giới hạn để tránh hỏng: tối đa ba lớp gọi lồng nhau, một node không tự gọi chính nó, và mỗi cuộc gọi hiện thành một task riêng trong run nên bạn đọc được đầy đủ nội dung hỏi đáp." },

          { type: "h4", text: "Ví dụ: PM gọi Frontend Engineer rồi gọi Code Reviewer" },
          {
            type: "steps",
            items: [
              "Ở tab Agents tạo ba agent: Project Manager, Frontend Engineer, Code Reviewer, mỗi cái có model, tool và skill hợp với vai trò.",
              "Ở tab Workflows tạo workflow mới, bấm \"Thêm bước đầu tiên\" để có node PM, rồi thêm hai node còn lại. Cạnh nối giữa ba node này không cần mang ý nghĩa gì, vì quan hệ thật đi qua cơ chế gọi 2 chiều.",
              "Chọn node PM, sang tab \"Gọi 2 chiều\", click chọn cả chip Frontend Engineer và Code Reviewer.",
              "Vẫn ở node PM, sang tab \"General\" viết prompt kiểu: bước 1 dùng ask_agent gọi Frontend Engineer giao việc rồi đợi code xong, bước 2 dùng ask_agent gọi Code Reviewer kèm mô tả thay đổi rồi đợi nhận xét, bước 3 tổng hợp báo cáo cuối.",
              "Chọn node Frontend Engineer, sang tab \"Trigger\", tick \"Chỉ chạy khi được gọi trực tiếp\".",
              "Làm tương tự với node Code Reviewer. Giờ cả hai node đều hiện badge \"chỉ gọi thủ công\" trên sơ đồ.",
              "Bấm Lưu, sang tab Chạy, chọn chế độ Workflow và workflow vừa tạo, nhập yêu cầu rồi bấm Chạy.",
            ],
          },
          { type: "p", text: "Kết quả: PM chạy trước vì là node duy nhất tự khởi động, nó gọi Frontend Engineer và đợi code xong thật, rồi gọi Code Reviewer và đợi review, cuối cùng mới viết báo cáo. Hai cuộc gọi hiện thành hai task riêng trong run, mở ra đọc được toàn bộ hỏi đáp." },
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
          { type: "h4", text: "Dừng giữa chừng và chạy tiếp" },
          { type: "p", text: "Run đang chạy có nút \"Dừng\" nằm ngay cạnh badge trạng thái. Bấm vào thì server kết thúc cả cây tiến trình của CLI đang chạy, không chỉ mỗi tiến trình cha: `claude` và `codex` đều chạy qua shim của npm và tự sinh thêm tiến trình con cho từng tool chúng gọi, nên giết mỗi tiến trình cha sẽ để lại cả nhánh con vẫn đang sửa file cho một run mà bạn vừa dừng. Đồng thời workflow cũng ngừng phát các bước chưa chạy." },
          { type: "p", text: "Dừng không phải là lỗi. Run và các bước bị ngắt hiện trạng thái \"Đã dừng\" bằng màu xám chứ không phải đỏ, và kết quả của những bước đã xong trước đó vẫn được giữ nguyên." },
          { type: "p", text: "Sau mỗi bước hoàn tất, hệ thống ghi checkpoint gồm trạng thái và kết quả của từng node vào lịch sử run. Nhờ vậy, run nào bị dừng, bị lỗi, hoặc dở dang lúc server sập đều hiện thêm nút \"Chạy tiếp\". Bấm vào thì các bước đã xong giữ nguyên kết quả và không chạy lại, chỉ những bước chưa xong mới chạy. Bước đang chạy dở lúc bị ngắt được coi là chưa xong nên sẽ chạy lại từ đầu, vì không có cách nào biết nó đã làm tới đâu." },
          { type: "p", text: "Log của lần chạy trước không bị xoá. Lần chạy mới thêm task của nó vào cuối danh sách, nên bạn đọc được cả hai lần, còn sơ đồ thì hiển thị theo lần chạy gần nhất của mỗi node. Đầu lần chạy tiếp có một dòng ghi rõ những bước nào được bỏ qua vì đã xong." },
          { type: "p", text: "Chỉ run theo workflow mới chạy tiếp được, vì checkpoint tính theo node của đồ thị. Run chế độ 1 Agent thì dừng được nhưng không chạy tiếp được." },
          { type: "h4", text: "Cách ly không gian làm việc bằng git worktree" },
          { type: "p", text: "Mặc định mọi node dùng chung một thư mục làm việc. Khi workflow rẽ nhánh, hai agent chạy cùng lúc có thể sửa cùng một file và ghi đè lên nhau, xong rồi cũng không biết ai đã ghi cái gì." },
          { type: "p", text: "Bật \"Cách ly không gian làm việc\" trong trang sửa workflow thì mỗi lần có từ hai node trở lên chạy song song, mỗi node được cấp một git worktree riêng: thư mục riêng, nhánh tạm riêng tách từ HEAD, dùng chung kho object của repo nên tạo rất nhanh. Agent làm gì trong đó cũng không đụng tới các nhánh khác." },
          { type: "p", text: "Chạy xong, hệ thống xử lý từng nhánh một, theo thứ tự: commit những gì agent sửa, chạy lệnh kiểm thử bạn khai báo ngay trong worktree đó, và chỉ khi kiểm thử đạt mới gộp về nhánh gốc rồi xoá worktree. Nhánh nào kiểm thử hỏng hoặc gộp bị xung đột thì không được gộp, node đó tính là lỗi, các bước phía sau nó bị bỏ qua, và worktree được giữ lại để bạn tự vào xem, đường dẫn nằm trong log của node đó. Riêng bước chạy một mình thì vẫn dùng thẳng thư mục làm việc như cũ, không tạo worktree." },
          { type: "p", text: "Toàn bộ quá trình này ghi vào một task riêng tên \"Không gian làm việc\" trong run, còn phần commit, kiểm thử và gộp thì nằm trong log của chính node tương ứng." },
          { type: "p", text: "Hai điều cần nhớ. Worktree chỉ có file mà git quản lý, nên thứ nằm trong .gitignore như node_modules hay .env sẽ không có ở đó, lệnh kiểm thử phải tự lo cài phụ thuộc nếu dự án cần. Và nên commit hoặc stash phần đang làm dở trước khi chạy, vì repo đang bẩn thì bước gộp dễ bị chặn. Nếu thư mục làm việc không phải git repo thì hệ thống bỏ qua phần cách ly và chạy như bình thường, có ghi rõ lý do trong log." },
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
          { type: "p", text: "Cách ly bằng worktree chỉ áp dụng cho các nhánh chạy song song của workflow, và chỉ khi thư mục làm việc là một git repo. Sub-agent do một agent tự sinh ra bằng tool Task vẫn chạy chung thư mục với agent cha, vì chúng nằm trong cùng một tiến trình CLI mà hệ thống này không điều phối được." },
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
          { type: "p", text: "Everything runs on your own machine. You type a request, the server spawns a real CLI process per agent: `claude -p` if that agent uses Claude Code, `codex exec` if it uses Codex. There's nowhere to paste an API key because none is needed. Each process just uses the CLI session you're already signed into." },
          { type: "p", text: "There are 4 things to configure. Agents are who does the work and which CLI runs them, Skills are shared knowledge, Plugins are real Claude Code plugins, and Workflows are how several agents work together. The Run tab starts things and shows progress. Run history is written to disk, so it survives a server restart." },
        ],
      },
      {
        id: "agents",
        heading: "2. Agents",
        blocks: [
          { type: "p", text: "The field that matters most is \"Runs on\": Claude Code or Codex. Picking it changes the rest of the form, because the two CLIs support different things. A CLI that isn't installed is greyed out in the dropdown with a warning, so you can't build an agent that's certain to fail." },
          { type: "h4", text: "Claude Code agents" },
          { type: "p", text: "You pick a model, a permission mode, and two lists of tools, allowed and denied. Turning on \"Read-only\" sets plan mode and blocks Edit and Write, which is handy for review agents." },
          { type: "p", text: "One entry in the tool list is worth pointing out: \"Spawn sub-agents\". Tick it and the agent can create its own sub-agents to work parts of a job in parallel, then merge the results. Ticking it is all you need to do. When the tool is on, the server adds usage guidance to the system prompt, and the agent works out for itself when splitting work is worth it. What the sub-agents produce shows up in that step's log." },
          { type: "p", text: "This is different from \"Two-way calls\" in section 6. A sub-agent here is a throwaway, general-purpose one the agent creates while running. ask_agent instead calls a specific agent you configured yourself, with its own model, skills and tools." },
          { type: "h4", text: "Codex agents" },
          { type: "p", text: "The model dropdown reads `~/.codex/models_cache.json`, the file the Codex CLI writes when you log in. That way the list always matches the models your account can really use, instead of a hardcoded list that goes stale." },
          { type: "p", text: "Codex has fewer permission controls than Claude, because `codex exec` only exposes so much. You get a Sandbox setting (`read-only`, `workspace-write`, `danger-full-access`) and a network access checkbox that only applies when the sandbox is `workspace-write`. There's no per-tool allow or deny, and no attaching Claude Code plugins." },
          { type: "p", text: "ask_agent, on the other hand, works for Codex exactly as it does for Claude: it can call other nodes and be called by them, in either direction across the two CLIs. Private and shared skills apply to Codex too — since `codex exec` has no system-prompt flag, their content is prepended to the prompt instead." },
          { type: "p", text: "\"Read-only\" picks a safe default for either kind: plan mode with Edit and Write blocked for Claude, a read-only sandbox for Codex." },
          { type: "h4", text: "Private skill and deleting an agent" },
          { type: "p", text: "A private skill is system-prompt text only that agent sees. For Codex agents it gets prepended to the prompt instead, since Codex has no `--append-system-prompt` flag. Shared skills come from the Skills tab." },
          { type: "p", text: "Plugins are attached from the Plugins tab, work only for Claude Code agents, and run through `--plugin-dir` or `--plugin-url`." },
          { type: "p", text: "Deleting an agent that a workflow still uses is refused, and the message names the workflow so you know where to go. Every delete asks first through the app's own dialog, never the browser's." },
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
        heading: "5. Workflows: the multi-agent graph",
        blocks: [
          { type: "p", text: "A workflow is a graph of nodes and edges, not just a straight chain. One node can fan out into parallel branches, and several branches can merge back into a single node." },
          { type: "h4", text: "Creating nodes and connecting edges" },
          {
            type: "steps",
            items: [
              "Go to the Workflows tab and click \"+ New workflow\", or \"Edit\" on one you already have.",
              "On an empty canvas, click \"Add first step\" to create the root node.",
              "Hover the top-right corner of a node to reveal two small buttons: \"+\" adds a child node and connects it, \"✕\" deletes the node.",
              "Click a node to select it and the edit panel opens on the right. The \"General\" section is always visible and is where you pick the agent and write that node's prompt.",
              "To connect an edge to a node that already exists instead of making a new one, select the source node, go to the \"Branches\" tab, pick the target agent from the dropdown and click \"+ Add branch\". This is also how you build a merge point.",
              "Drag a node to move it around the canvas, press and drag rather than click. Scroll to zoom, drag the empty background to pan.",
            ],
          },
          { type: "p", text: "A node's prompt can use {{prompt}} for the original request and {{previous}} for the output of whatever fed into it. Leave it empty and the system fills in a default." },
        ],
      },
      {
        id: "interaction",
        heading: "6. Three ways agents interact",
        blocks: [
          { type: "p", text: "There are three mechanisms, from simple to flexible. Pick whichever fits what you're building, you don't need all three." },

          { type: "h4", text: "1. Edges, one-way data flow" },
          {
            type: "steps",
            items: [
              "Select the source node on the canvas.",
              "Click the \"+\" on the node's corner to create a child node with an edge. Or open the \"Branches\" tab, pick an existing node from the dropdown, and click \"+ Add branch\".",
              "That's all. At run time the target node starts as soon as the source finishes and receives its output as {{previous}}.",
            ],
          },
          { type: "p", text: "Good when the order of steps is fixed and known ahead of time and nothing has to be decided. One step finishes, the next runs, or several run at once if a node has more than one outgoing edge." },

          { type: "h4", text: "2. Router, conditional branching" },
          {
            type: "steps",
            items: [
              "Select the node you want as the router, usually one that already has two or more outgoing branches.",
              "Right panel, \"Trigger\" tab, tick the Router checkbox.",
              "Go to the \"Branches\" tab. Each branch now has a \"condition\" field, which only appears for router nodes. Type a short keyword like \"bug\" or \"ok\".",
              "Save the workflow.",
            ],
          },
          { type: "p", text: "At run time the system matches the router's answer against each keyword, case-insensitively. The branch that matches carries on, the rest get a \"Skipped\" badge and cost nothing." },
          { type: "p", text: "Good when you need to branch on a result. A check node that found a bug routes to a fix node, otherwise it routes to a docs node." },

          { type: "h4", text: "3. Two-way calls with ask_agent" },
          { type: "p", text: "This is the flexible one. Node A can ask node B a question while it's still running, wait for the full answer, then carry on with it, the way a project manager hands out work and waits for the report before assigning the next thing. The order isn't in the diagram at all. The agent decides it at run time from the prompt you wrote." },
          { type: "p", text: "It doesn't care which CLI is on either end. The bridge is an ordinary stdio MCP server and both `claude` and `codex` run the exact same process, only wired up with different flags. So a Codex node can call a Claude node, a Claude node can call a Codex node, and either can call its own kind — same node ids on the canvas, same per-node callee permissions, same depth limit against call loops." },
          {
            type: "steps",
            items: [
              "Select the node doing the calling, say the Project Manager node.",
              "Right panel, \"Two-way calls\" tab.",
              "Click the chip for each node this one is allowed to call. The chip changes colour when selected and shows the node's real id, like `nextjs-frontend-engineer · id=\"nwvl6e3\"`. You can pick several.",
              "Go to the \"General\" tab and write the caller's prompt properly: who to call first, who next, what to send each of them. The configuration only grants permission to call. Order and content come from this prompt.",
              "Worth doing as well: select each node being called, go to its \"Trigger\" tab and tick \"Only runs when called directly\". Without that, a called node both starts on its own from the graph and gets called, so it runs twice.",
              "You don't need edges between nodes that use this. The call relationship is completely separate from data edges, and shows on the canvas as a dashed purple line with an arrow.",
            ],
          },
          { type: "p", text: "About ids: every node has one, shown in three places. On the canvas under the node title, in the \"This step's id\" box in the General tab, and on each chip in the \"Two-way calls\" tab. That's the id ask_agent takes, not the agent id from the Agents tab. You don't strictly have to copy it into the prompt, since the list of callable nodes and their ids is already in the tool's own description at run time, so naming the agent is usually enough. Writing the id in explicitly is still safer with a smaller model, so it doesn't confuse two nodes with similar names." },
          { type: "p", text: "A few guards: at most three levels of nested calls, a node can never call itself, and each call becomes its own task in the run so you can read the whole exchange." },

          { type: "h4", text: "Worked example: PM calls the engineer, then the reviewer" },
          {
            type: "steps",
            items: [
              "In the Agents tab create three agents: Project Manager, Frontend Engineer and Code Reviewer, each with a model, tools and skills that suit the role.",
              "In the Workflows tab create a workflow, click \"Add first step\" for the PM node, then add the other two. The edges between them don't need to mean anything, since the real relationship goes through two-way calls.",
              "Select the PM node, open \"Two-way calls\" and click both the Frontend Engineer and Code Reviewer chips.",
              "Still on the PM node, go to \"General\" and write a prompt along these lines: step one, use ask_agent to call the Frontend Engineer, assign the work and wait for the code. Step two, use ask_agent to call the Code Reviewer with a summary of the changes and wait for feedback. Step three, write the final report.",
              "Select the Frontend Engineer node, open \"Trigger\" and tick \"Only runs when called directly\".",
              "Do the same for the Code Reviewer node. Both should now show a \"manual call only\" badge on the canvas.",
              "Save, go to the Run tab, choose Workflow mode and the workflow you just built, type the request and hit Run.",
            ],
          },
          { type: "p", text: "What happens: the PM runs first, since it's the only node that starts on its own. It calls the engineer and waits for actual code, then calls the reviewer and waits for the review, then writes its report. Both calls appear as separate tasks in the run with the full exchange inside." },
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
          { type: "h4", text: "Stopping and resuming" },
          { type: "p", text: "A running run has a \"Stop\" button next to its status badge. Click it and the server kills the running CLI's entire process tree, not just the top process: `claude` and `codex` both run through an npm shim and spawn further processes for the tools they call, so killing only the parent would leave that whole subtree still editing files for a run you just stopped. The workflow also stops handing out steps that haven't started." },
          { type: "p", text: "Stopping isn't a failure. The run and its interrupted steps show as \"Stopped\" in grey rather than error red, and whatever earlier steps produced is kept." },
          { type: "p", text: "After each step finishes, the system checkpoints that node's status and result into the run history. So any run that was stopped, failed, or was mid-flight when the server died also gets a \"Resume\" button. Steps that already finished keep their results and aren't run again; only unfinished ones run. A step that was in flight when it was interrupted counts as unfinished and starts over, since there's no way to know how far it got." },
          { type: "p", text: "The previous attempt's log isn't discarded. The new attempt appends its own tasks at the end, so you can read both, while the diagram reflects each node's most recent attempt. A line at the start of the resumed attempt spells out which steps were skipped as already done." },
          { type: "p", text: "Only workflow runs can be resumed, since the checkpoint is per graph node. A 1 Agent run can be stopped but not resumed." },
          { type: "h4", text: "Workspace isolation with git worktrees" },
          { type: "p", text: "By default every node shares one working directory. When a workflow fans out, two agents running at once can edit the same file and overwrite each other, and afterwards there's no way to tell who wrote what." },
          { type: "p", text: "Switch on \"Workspace isolation\" in the workflow editor and every time two or more nodes run in parallel, each one gets its own git worktree: its own directory, its own temp branch off HEAD, sharing the repo's object store so it's cheap to create. Whatever an agent does in there can't touch the other branches." },
          { type: "p", text: "Once they finish, each branch is handled one at a time, in order: commit whatever the agent changed, run the test command you configured inside that worktree, and merge back into the base branch only if it passed, then remove the worktree. A branch that fails its tests or hits a merge conflict isn't merged, its node counts as failed, the steps downstream of it are skipped, and the worktree stays on disk for you to look at, with the path in that node's log. A step running on its own still uses the working directory directly, with no worktree involved." },
          { type: "p", text: "The whole process is logged to a separate \"Workspace\" task in the run, while the commit, test and merge for each branch go into that node's own log." },
          { type: "p", text: "Two things to keep in mind. A worktree only contains git-tracked files, so anything in .gitignore like node_modules or .env won't be there, and your test command has to install dependencies itself if the project needs them. And commit or stash work-in-progress before running, because a dirty repo tends to block the merge step. If the working directory isn't a git repo at all, isolation is skipped and the run proceeds as normal, with the reason written to the log." },
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
          { type: "p", text: "Worktree isolation only covers a workflow's parallel branches, and only when the working directory is a git repo. Sub-agents an agent spawns itself with the Task tool still share their parent's directory, since they live inside a single CLI process this system doesn't orchestrate." },
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
