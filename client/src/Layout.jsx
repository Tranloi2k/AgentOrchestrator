import React from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  IconPlay,
  IconAgent,
  IconSkill,
  IconWorkflow,
  IconPlugin,
  IconBook,
  IconLogo,
  IconTranslate,
  IconSun,
  IconMoon,
} from "./Icons.jsx";
import { Button } from "./components/index.js";
import { usePreferences } from "./PreferencesContext.jsx";
import { usePageMeta } from "./PageMetaContext.jsx";

const NAV_ITEMS = [
  { path: "/run", icon: IconPlay, labelKey: "nav.run", descKey: "nav.run.desc" },
  { path: "/agents", icon: IconAgent, labelKey: "nav.agents", descKey: "nav.agents.desc" },
  { path: "/skills", icon: IconSkill, labelKey: "nav.skills", descKey: "nav.skills.desc" },
  { path: "/plugins", icon: IconPlugin, labelKey: "nav.plugins", descKey: "nav.plugins.desc" },
  { path: "/workflows", icon: IconWorkflow, labelKey: "nav.workflows", descKey: "nav.workflows.desc" },
];

const DOCS_ITEM = { path: "/docs", icon: IconBook, labelKey: "nav.docs", descKey: "nav.docs.desc" };

function isNavActive(path, pathname) {
  if (path === "/run") return pathname === "/run";
  return pathname === path || pathname.startsWith(`${path}/`);
}

function matchNavItem(pathname) {
  return [...NAV_ITEMS, DOCS_ITEM].find((item) => isNavActive(item.path, pathname)) || NAV_ITEMS[0];
}

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { locale, setLocale, theme, setTheme, t } = usePreferences();
  const { meta } = usePageMeta();
  const current = matchNavItem(location.pathname);

  function toggleLocale() {
    setLocale(locale === "vi" ? "en" : "vi");
  }

  function toggleTheme() {
    setTheme(theme === "light" ? "dark" : "light");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar-nav">
        <div className="sidebar-brand">
          <IconLogo size={28} title={t("app.brand")} />
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-name">{t("app.brand")}</span>
            <span className="sidebar-brand-sub">{t("app.subtitle")}</span>
          </div>
        </div>

        <nav className="sidebar-menu">
          <div className="sidebar-section-label">{t("nav.section")}</div>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isNavActive(item.path, location.pathname);
            return (
              <button
                key={item.path}
                type="button"
                className={`nav-item ${active ? "active" : ""}`}
                onClick={() => navigate(item.path)}
              >
                <span className="nav-item-icon">
                  <Icon size={16} />
                </span>
                <span className="nav-item-label">{t(item.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button
            type="button"
            className={`nav-item ${isNavActive(DOCS_ITEM.path, location.pathname) ? "active" : ""}`}
            onClick={() => navigate(DOCS_ITEM.path)}
          >
            <span className="nav-item-icon">
              <IconBook size={16} />
            </span>
            <span className="nav-item-label">{t(DOCS_ITEM.labelKey)}</span>
          </button>
          <div className="sidebar-version">{t("app.version")}</div>
        </div>
      </aside>

      <div className="app-main">
        <header className="page-header">
          <div className="page-header-text">
            <h1 className="page-title">{meta?.title ?? t(current.labelKey)}</h1>
            <p className="page-subtitle">{meta?.subtitle ?? t(current.descKey)}</p>
          </div>
          <div className="page-header-actions">
            <Button
              variant="headerIcon"
              onClick={toggleLocale}
              title={t("settings.switchLanguage")}
              aria-label={t("settings.switchLanguage")}
            >
              <IconTranslate />
              <span className="header-icon-label">{locale.toUpperCase()}</span>
            </Button>
            <Button
              variant="headerIcon"
              className={`theme-btn ${theme === "light" ? "is-light" : "is-dark"}`}
              onClick={toggleTheme}
              title={t("settings.switchTheme")}
              aria-label={t("settings.switchTheme")}
            >
              {theme === "light" ? <IconSun /> : <IconMoon />}
            </Button>
          </div>
        </header>

        <div className="page-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
