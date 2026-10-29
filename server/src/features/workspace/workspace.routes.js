import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_CWD } from "../../core/config.js";
import { ALLOWED_ROOTS, isPathAllowed, checkCwd } from "../../core/security.js";
import { listBranches } from "./workspace.js";

// "Computer" level of the folder picker: every drive (or "/"), above any single folder.
const ROOTS_VIEW = "::roots";

/** Drives on Windows (C:\, D:\ …), "/" elsewhere — or the ALLOWED_ROOTS when those are set. */
function browseRoots() {
  if (ALLOWED_ROOTS.length) return ALLOWED_ROOTS.map((r) => ({ name: r, path: r }));
  if (process.platform !== "win32") return [{ name: "/", path: "/" }];
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    if (existsSync(drive)) drives.push({ name: drive, path: drive });
  }
  return drives;
}

/** The working folder and its git repo: folder picker and target-branch list. */
export function register(app) {
  /** Read-only directory browser so the UI can offer a "Browse..." picker for the working-directory
   * field without a native OS dialog. Opens at the user's home folder; can go anywhere the server
   * may run agents (any drive, unless ALLOWED_ROOTS narrows it). `path=::roots` lists the drives. */
  app.get("/api/browse-dirs", (req, res) => {
    const requested = req.query.path ? String(req.query.path).trim() : "";
    if (requested === ROOTS_VIEW) {
      return res.json({ path: null, parent: null, dirs: browseRoots(), roots: true });
    }
    const home = homedir();
    const fallback = isPathAllowed(home) ? home : isPathAllowed(DEFAULT_CWD) ? DEFAULT_CWD : ALLOWED_ROOTS[0];
    const target = path.resolve(requested || fallback);
    if (!isPathAllowed(target)) {
      return res.status(403).json({ error: "Thư mục nằm ngoài các thư mục được phép (ALLOWED_ROOTS)" });
    }

    let entries;
    try {
      entries = readdirSync(target, { withFileTypes: true });
    } catch (err) {
      return res.status(400).json({ error: `Không đọc được thư mục: ${err.message}` });
    }

    const dirs = entries
      // Hidden folders, and Windows system ones like $Recycle.Bin / System Volume Information.
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("$") && e.name !== "System Volume Information")
      .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Going up from a drive root (or an allowed root) leads to the "Computer" view.
    const up = path.dirname(target);
    const parent = up !== target && isPathAllowed(up) ? up : ROOTS_VIEW;
    res.json({ path: target, parent, dirs });
  });

  /** Local branches of the git repo containing `cwd` (target-branch picker); `repo: null` if not git. */
  app.get("/api/git/branches", async (req, res) => {
    const cwd = String(req.query.cwd || DEFAULT_CWD);
    if (!checkCwd(cwd, res)) return;
    res.json({ repo: await listBranches(cwd) });
  });
}
