import React, { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  IconPlay,
  IconAgent,
  IconSkill,
  IconWorkflow,
  IconPlugin,
  IconKey,
  IconUsage,
  IconBook,
  IconLogo,
  IconTranslate,
  IconSun,
  IconMoon,
  IconSidebar,
} from "../shared/Icons.jsx";
import { Button, InfoTip } from "../shared/components/index.js";
import { usePreferences } from "./PreferencesContext.jsx";
import { usePageMeta } from "./PageMetaContext.jsx";

const NAV_ITEMS = [
  { path: "/run", icon: IconPlay, labelKey: "nav.run" },
  { path: "/agents", icon: IconAgent, labelKey: "nav.agents" },
  { path: "/skills", icon: IconSkill, labelKey: "nav.skills" },
  { path: "/plugins", icon: IconPlugin, labelKey: "nav.plugins" },
  { path: "/workflows", icon: IconWorkflow, labelKey: "nav.workflows" },
  { path: "/providers", icon: IconKey, labelKey: "nav.providers" },
  { path: "/usage", icon: IconUsage, labelKey: "nav.usage" },
];

const DOCS_ITEM = { path: "/docs", icon: IconBook, labelKey: "nav.docs" };

function isNavActive(path, pathname) {
  if (path === "/run") return pathname === path || pathname.startsWith(`${path}/`);
  return pathname === path || pathname.startsWith(`${path}/`);
}

function matchNavItem(pathname) {
  return [...NAV_ITEMS, DOCS_ITEM].find((item) => isNavActive(item.path, pathname)) || NAV_ITEMS[0];
}

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { locale, setLocale, theme, setTheme, t } = usePreferences();
  const { meta, hint } = usePageMeta();
  const current = matchNavItem(location.pathname);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("sidebarCollapsed", sidebarCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [sidebarCollapsed]);

  // Ctrl/Cmd+B toggles the sidebar, as in most editors.
  useEffect(() => {
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function toggleLocale() {
    setLocale(locale === "vi" ? "en" : "vi");
  }

  function toggleTheme() {
    setTheme(theme === "light" ? "dark" : "light");
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar-nav">
        <div className="sidebar-brand">
          <IconLogo size={26} title={`${t("app.brand")} · ${t("app.version")}`} />
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-name">{t("app.brand")}</span>
          </div>
          <button
            type="button"
            className="sidebar-toggle-btn"
            onClick={() => setSidebarCollapsed((c) => !c)}
            title={`${t(sidebarCollapsed ? "settings.showSidebar" : "settings.hideSidebar")} (Ctrl+B)`}
            aria-label={t(sidebarCollapsed ? "settings.showSidebar" : "settings.hideSidebar")}
            aria-expanded={!sidebarCollapsed}
          >
            <IconSidebar />
          </button>
        </div>

        <nav className="sidebar-menu">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isNavActive(item.path, location.pathname);
            return (
              <button
                key={item.path}
                type="button"
                className={`nav-item ${active ? "active" : ""}`}
                onClick={() => navigate(item.path)}
                title={sidebarCollapsed ? t(item.labelKey) : undefined}
                aria-label={t(item.labelKey)}
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
            title={sidebarCollapsed ? t(DOCS_ITEM.labelKey) : undefined}
            aria-label={t(DOCS_ITEM.labelKey)}
          >
            <span className="nav-item-icon">
              <IconBook size={16} />
            </span>
            <span className="nav-item-label">{t(DOCS_ITEM.labelKey)}</span>
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="page-header">
          <div className="page-title-row">
            <h1 className="page-title">{meta?.title ?? t(current.labelKey)}</h1>
            <InfoTip>{hint}</InfoTip>
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
