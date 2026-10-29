import React, { useEffect, useState } from "react";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { Button, Modal } from "../../shared/components/index.js";

/**
 * A file's diff. New reviews carry it per file (server/workspace.js splitPatchByFile); older ones
 * only have the run's whole patch, so the file's section is looked up there. Never falls back to
 * the whole patch — showing another file's diff is worse than showing none.
 */
function fileDiff(review, file) {
  if (!file) return "";
  if (typeof file.patch === "string") return file.patch;
  const sections = (review.patch || "").split(/(?=^diff --git )/m);
  return sections.find((s) => s.split("\n", 1)[0].endsWith(` b/${file.path}`)) || "";
}

function DiffLine({ line }) {
  const className =
    line.startsWith("+") && !line.startsWith("+++")
      ? "diff-add"
      : line.startsWith("-") && !line.startsWith("---")
        ? "diff-delete"
        : line.startsWith("@@")
          ? "diff-hunk"
          : line.startsWith("diff ") || line.startsWith("index ")
            ? "diff-meta"
            : "";
  return <span className={className}>{line || " "}</span>;
}

function FileCounts({ file }) {
  if (file.additions === null || file.additions === undefined) return null;
  return (
    <span className="review-file-counts">
      <b>+{file.additions}</b> <i>-{file.deletions}</i>
    </span>
  );
}

/** Full-screen review: file list on the left, the selected file's diff on the right. */
function ReviewModal({ review, busy, onAccept, onDecline, onClose }) {
  const { t } = usePreferences();
  const files = review.files || [];
  const [selectedPath, setSelectedPath] = useState(files[0]?.path || "");
  useEffect(() => {
    if (!files.some((f) => f.path === selectedPath)) setSelectedPath(files[0]?.path || "");
  }, [files, selectedPath]);

  const selected = files.find((f) => f.path === selectedPath);
  const diff = fileDiff(review, selected);
  const pending = review.status === "pending";

  return (
    <Modal
      onClose={onClose}
      title={`${t("run.review.title")} · ${t("run.review.summary", { count: files.length })} · ${t("run.review.into", { branch: review.baseBranch })}`}
      panelClassName="review-modal"
      footer={
        pending && (
          <div className="review-modal-footer">
            <Button variant="secondary" color="danger" disabled={busy} onClick={onDecline}>
              {t("run.review.decline")}
            </Button>
            <Button variant="primary" disabled={busy} onClick={onAccept}>
              {busy ? t("run.review.processing") : t("run.review.accept")}
            </Button>
          </div>
        )
      }
    >
      <div className="review-modal-body">
        <div className="review-file-list">
          {files.map((file) => (
            <button
              type="button"
              key={`${file.previousPath || ""}-${file.path}`}
              className={file.path === selectedPath ? "active" : ""}
              title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
              onClick={() => setSelectedPath(file.path)}
            >
              <span className={`review-file-status status-${file.status}`}>{file.status}</span>
              <span className="review-file-path">{file.path}</span>
              <FileCounts file={file} />
            </button>
          ))}
        </div>
        <div className="review-diff">
          <div className="review-diff-title">{selected?.path}</div>
          {diff ? (
            <pre key={selectedPath}>
              {diff.split("\n").map((line, index) => (
                <DiffLine key={index} line={line} />
              ))}
            </pre>
          ) : (
            <div className="review-diff-empty">{t("run.review.noDiff")}</div>
          )}
          {(selected?.patchTruncated || (!selected?.patch && review.patchTruncated)) && (
            <div className="review-truncated">{t("run.review.truncated")}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * The review on the Run page: a compact bar (counts, target branch, status, Accept / Decline)
 * with the files and diffs in a popup.
 */
export default function ReviewPanel({ review, busy, onAccept, onDecline }) {
  const { t } = usePreferences();
  const [open, setOpen] = useState(false);

  if (!review) return null;
  if (review.status === "unavailable") {
    return (
      <section className="run-review run-review-unavailable">
        <strong>{t("run.review.unavailable")}</strong>
        <span>{review.reason}</span>
      </section>
    );
  }
  if (review.status === "no_changes") return <div className="run-review-empty">✓ {t("run.review.noChanges")}</div>;

  const files = review.files || [];
  const additions = files.reduce((n, f) => n + (f.additions || 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions || 0), 0);
  const pending = review.status === "pending";
  // Decline asks for confirmation in a dialog of its own, so the popup steps aside first.
  const decline = () => {
    setOpen(false);
    onDecline();
  };
  const accept = async () => {
    await onAccept();
    setOpen(false);
  };

  return (
    <>
      <section className="run-review run-review-bar">
        <div className="run-review-bar-info">
          <h3>{t("run.review.title")}</h3>
          <p>
            {t("run.review.summary", { count: files.length })} · <b className="review-add">+{additions}</b>{" "}
            <i className="review-del">-{deletions}</i> · {t("run.review.into", { branch: review.baseBranch })}
          </p>
        </div>
        <span className={`review-state review-state-${review.status}`}>{t(`run.review.status.${review.status}`)}</span>
        <div className="run-review-actions">
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {t("run.review.open")}
          </Button>
          {pending && (
            <>
              <Button variant="secondary" color="danger" disabled={busy} onClick={decline}>
                {t("run.review.decline")}
              </Button>
              <Button variant="primary" disabled={busy} onClick={accept}>
                {busy ? t("run.review.processing") : t("run.review.accept")}
              </Button>
            </>
          )}
        </div>
      </section>
      {open && <ReviewModal review={review} busy={busy} onAccept={accept} onDecline={decline} onClose={() => setOpen(false)} />}
    </>
  );
}
