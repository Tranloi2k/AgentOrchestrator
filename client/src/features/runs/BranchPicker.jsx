import React, { useEffect, useState } from "react";
import { api } from "../../shared/api.js";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { CheckboxField, HelperText } from "../../shared/components/index.js";

/**
 * Target git branch for a run: where the agent's code lands once you Accept it. Re-reads the
 * branch list whenever the working directory changes. `value` = { branch, newBranch } (newBranch
 * empty = use `branch` as is; otherwise a new branch is created from `branch` when the run starts).
 */
export default function BranchPicker({ cwd, value, onChange }) {
  const { t } = usePreferences();
  const [repo, setRepo] = useState(undefined); // undefined = loading, null = not a git repo
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRepo(undefined);
    const timer = setTimeout(() => {
      api
        .gitBranches(cwd)
        .then((d) => {
          if (cancelled) return;
          setRepo(d.repo);
          // Keep a still-valid choice; otherwise default to the checked-out branch.
          if (d.repo && !d.repo.branches.includes(value.branch)) onChange({ branch: d.repo.current, newBranch: value.newBranch });
        })
        .catch(() => !cancelled && setRepo(null));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  if (repo === undefined) return null;
  if (repo === null) {
    return (
      <div className="run-field">
        <label>{t("run.branch")}</label>
        <HelperText>{t("run.branch.notGit")}</HelperText>
      </div>
    );
  }

  return (
    <div className="run-field">
      <label htmlFor="run-branch">{t(creating ? "run.branch.from" : "run.branch")}</label>
      <select id="run-branch" value={value.branch} onChange={(e) => onChange({ ...value, branch: e.target.value })}>
        {repo.branches.map((b) => (
          <option key={b} value={b}>
            {b}
            {b === repo.current ? ` (${t("run.branch.current")})` : ""}
          </option>
        ))}
      </select>
      <CheckboxField
        id="run-new-branch"
        checked={creating}
        onChange={(checked) => {
          setCreating(checked);
          onChange({ ...value, newBranch: checked ? value.newBranch : "" });
        }}
        label={t("run.branch.create")}
      />
      {creating && (
        <input
          type="text"
          value={value.newBranch}
          placeholder={t("run.branch.newPlaceholder")}
          onChange={(e) => onChange({ ...value, newBranch: e.target.value.replace(/\s+/g, "-") })}
        />
      )}
      <HelperText>
        {t("run.branch.hint", { branch: creating && value.newBranch.trim() ? value.newBranch.trim() : value.branch })}
      </HelperText>
    </div>
  );
}
