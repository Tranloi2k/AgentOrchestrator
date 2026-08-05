import logoUrl from "./assets/logo.png";

export function IconPlay({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 2.5v11l9-5.5-9-5.5z" />
    </svg>
  );
}

export function IconAgent({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" strokeLinecap="round" />
    </svg>
  );
}

export function IconSkill({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 1.5l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 5.7l4-.6L8 1.5z" strokeLinejoin="round" />
    </svg>
  );
}

export function IconWorkflow({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="1" y="5" width="4" height="4" rx="1" />
      <rect x="11" y="1" width="4" height="4" rx="1" />
      <rect x="11" y="11" width="4" height="4" rx="1" />
      <path d="M5 7h3.5a1.5 1.5 0 0 0 1.5-1.5V3M5 9h3.5a1.5 1.5 0 0 1 1.5 1.5V13" strokeLinecap="round" />
    </svg>
  );
}

export function IconPlugin({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path
        d="M5.5 2.5v1.75a.75.75 0 0 1-.75.75H3v3h1.75a.75.75 0 0 1 .75.75V10.5h3V8.75a.75.75 0 0 1 .75-.75H11V5h-1.75a.75.75 0 0 1-.75-.75V2.5h-3z"
        strokeLinejoin="round"
      />
      <path d="M3 8.75V11a1.5 1.5 0 0 0 1.5 1.5h2.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconPlus({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M8 2.5v11M2.5 8h11" strokeLinecap="round" />
    </svg>
  );
}

export function IconClose({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
    </svg>
  );
}

export function IconTrash({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2.5 4h11" strokeLinecap="round" />
      <path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 4l.5 8.5a1 1 0 0 0 1 .9h5a1 1 0 0 0 1-.9L12 4" strokeLinejoin="round" />
      <path d="M6.5 7v4M9.5 7v4" strokeLinecap="round" />
    </svg>
  );
}

export function IconCopy({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M10.5 5.5V4.2A1.2 1.2 0 0 0 9.3 3H4.2A1.2 1.2 0 0 0 3 4.2v5.1A1.2 1.2 0 0 0 4.2 10.5H5.5" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCheck({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconShieldAlert({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 1.5L3 3.5v4.5c0 2.8 2.1 5.4 5 6 2.9-.6 5-3.2 5-6V3.5L8 1.5z" strokeLinejoin="round" />
      <path d="M8 5.5v3" strokeLinecap="round" />
      <circle cx="8" cy="10.5" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconBook({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path
        d="M2 3.2c0-.4.3-.7.7-.6C4.3 2.9 6 3.5 7.5 4.5v8.3C6 11.8 4.3 11.2 2.7 10.9a.7.7 0 0 1-.7-.7V3.2z"
        strokeLinejoin="round"
      />
      <path
        d="M14 3.2c0-.4-.3-.7-.7-.6-1.6.3-3.3.9-4.8 1.9v8.3c1.5-1 3.2-1.6 4.8-1.9a.7.7 0 0 0 .7-.7V3.2z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconLogo({ size = 24, title }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      title={title}
      aria-hidden={title ? undefined : true}
      className="app-logo"
      draggable={false}
    />
  );
}

export function IconChevronRight({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M5 3l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconTranslate({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z" />
    </svg>
  );
}

export function IconSun({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="9" cy="9" r="3" />
      <path d="M9 2v1.5M9 14.5V16M2 9h1.5M14.5 9H16M4.05 4.05l1.06 1.06M12.89 12.89l1.06 1.06M13.95 4.05l-1.06 1.06M5.11 12.89l-1.06 1.06" strokeLinecap="round" />
    </svg>
  );
}

export function IconMoon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path
        d="M14.5 10.25a5.75 5.75 0 0 1-7-7 6.25 6.25 0 1 0 7 7z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Official Anthropic Claude symbol (from claude.ai) */
export function IconProviderClaude({ size = 18, title }) {
  return (
    <img
      src="/icons/claude.svg"
      width={size}
      height={size}
      alt={title || "Claude"}
      className="provider-icon-img"
      draggable={false}
    />
  );
}

/** Official OpenAI emblem — Codex runs on OpenAI CLI */
export function IconProviderCodex({ size = 18, title }) {
  return (
    <img
      src="/icons/openai-emblem.svg"
      width={size}
      height={size}
      alt={title || "Codex"}
      className="provider-icon-img provider-icon-img-openai"
      draggable={false}
    />
  );
}

export function ProviderIcon({ provider = "claude", size = 18, title }) {
  const isCodex = provider === "codex";
  const label = title || (isCodex ? "Codex" : "Claude Code");
  return (
    <span
      className={`provider-icon ${isCodex ? "provider-icon-codex" : "provider-icon-claude"}`}
      title={label}
      aria-label={label}
      role="img"
    >
      {isCodex ? <IconProviderCodex size={size} title={label} /> : <IconProviderClaude size={size} title={label} />}
    </span>
  );
}
