# Lộ trình: Lớp Harness Adapter

Mục tiêu: gom mọi thứ riêng của từng CLI (Claude Code, Codex, sau này Gemini CLI) vào các adapter có chung một interface, để phần còn lại của server và UI không cần biết agent đang chạy bằng gì.

File này chỉ đánh dấu tiến độ. Ghi chú kiến thức để ở file riêng.

## Tiến độ

- [ ] 1. Quan sát event stream thô của Claude Code và Codex, lưu lại làm fixture
- [ ] 2. Thiết kế event chuẩn (normalized event)
- [ ] 3. Thiết kế interface `HarnessAdapter` (detect, listModels, capabilities, start, parseEvent, classifyFailure)
- [ ] 4. Tách phần chạy process dùng chung (spawn, theo dõi, đọc từng dòng stdout, stderr, kết thúc)
- [ ] 5. Chuyển Claude Code sang adapter
- [ ] 6. Chuyển Codex sang adapter
- [ ] 7. Registry harness, thay `PROVIDERS` và `runAgentProcess`
- [ ] 8. Unit test `parseEvent` bằng fixture ở bước 1
- [ ] 9. `/api/meta` trả `capabilities`, form agent ở UI hiển thị theo `capabilities`
- [ ] 10. Thêm adapter Gemini CLI
