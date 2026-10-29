import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { Button, ErrorBox, FormActions, HelperText, Modal } from "./index.js";

const ROOTS_VIEW = "::roots"; // the server's "Computer" level: every drive

const PLACE_ICONS = { computer: "🖥️", home: "🏠", desktop: "🖥", documents: "📄", downloads: "⬇️", default: "⭐" };

/**
 * Folder picker for a working directory. Can start anywhere the server may run agents: the
 * "Computer" level lists every drive, shortcuts jump to home / Desktop / Documents / Downloads,
 * and a path can be typed or pasted directly.
 */
export default function DirBrowserModal({ startPath, onSelect, onClose }) {
  const { t } = usePreferences();
  const [current, setCurrent] = useState(null); // null = Computer view
  const [parent, setParent] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [places, setPlaces] = useState([]);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  function load(target) {
    setLoading(true);
    setError("");
    api
      .browseDirs(target)
      .then((d) => {
        setCurrent(d.path);
        setParent(d.parent);
        setDirs(d.dirs);
        if (d.places) setPlaces(d.places);
        setTyped(d.path || "");
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(startPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inComputer = current === null && !loading && !error;

  return (
    <Modal
      title={t("browse.title")}
      onClose={onClose}
      closeLabel={t("common.close")}
      panelClassName="dir-browser"
      footer={
        <FormActions>
          <Button variant="primary" onClick={() => onSelect(current)} disabled={!current}>
            {t("browse.select")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </FormActions>
      }
    >
      <div className="dir-places">
        {places.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`dir-place ${(p.path === ROOTS_VIEW ? current === null : current === p.path) ? "active" : ""}`}
            title={p.path === ROOTS_VIEW ? t("browse.place.computer") : p.path}
            onClick={() => load(p.path)}
          >
            <span>{PLACE_ICONS[p.key]}</span> {t(`browse.place.${p.key}`)}
          </button>
        ))}
      </div>

      <form
        className="dir-path-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) load(typed.trim());
        }}
      >
        <input type="text" value={typed} placeholder={t("browse.typePath")} onChange={(e) => setTyped(e.target.value)} aria-label={t("browse.typePath")} />
        <Button variant="secondary" type="submit">
          {t("browse.go")}
        </Button>
      </form>
      <ErrorBox>{error}</ErrorBox>

      <div className="modal-list">
        {parent !== null && !error && (
          <div className="modal-list-item" onClick={() => load(parent)}>
            .. ({parent === ROOTS_VIEW ? t("browse.place.computer") : t("browse.up")})
          </div>
        )}
        {loading && <HelperText>{t("detail.loading")}</HelperText>}
        {!loading && !dirs.length && !error && <HelperText>{t("browse.empty")}</HelperText>}
        {dirs.map((d) => (
          <div key={d.path} className="modal-list-item" onClick={() => load(d.path)}>
            {inComputer ? "💽" : "📁"} {d.name}
          </div>
        ))}
      </div>
      {inComputer && <HelperText>{t("browse.computerHint")}</HelperText>}
    </Modal>
  );
}
