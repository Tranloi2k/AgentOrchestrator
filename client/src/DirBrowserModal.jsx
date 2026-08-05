import React, { useEffect, useState } from "react";
import { api } from "./api.js";
import { usePreferences } from "./PreferencesContext.jsx";
import { Button, ErrorBox, FormActions, HelperText, Modal } from "./components/index.js";

export default function DirBrowserModal({ startPath, onSelect, onClose }) {
  const { t } = usePreferences();
  const [current, setCurrent] = useState(null);
  const [parent, setParent] = useState(null);
  const [dirs, setDirs] = useState([]);
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
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(startPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal
      title={t("browse.title")}
      onClose={onClose}
      closeLabel={t("common.close")}
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
      <div className="modal-path">{current}</div>
      <ErrorBox>{error}</ErrorBox>

      <div className="modal-list">
        {parent !== null && (
          <div className="modal-list-item" onClick={() => load(parent)}>
            .. ({t("browse.up")})
          </div>
        )}
        {loading && <HelperText>{t("detail.loading")}</HelperText>}
        {!loading && !dirs.length && !error && <HelperText>{t("browse.empty")}</HelperText>}
        {dirs.map((d) => (
          <div key={d.path} className="modal-list-item" onClick={() => load(d.path)}>
            📁 {d.name}
          </div>
        ))}
      </div>
    </Modal>
  );
}
