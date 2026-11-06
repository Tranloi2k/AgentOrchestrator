import React, { createContext, useContext, useMemo, useState } from "react";

const PageMetaContext = createContext(null);

export function PageMetaProvider({ children }) {
  const [meta, setMeta] = useState(null);
  // Page-level guidance shown as an (i) tip beside the header title; kept apart from `meta`
  // so a page that only sets a hint doesn't clobber a detail page's title/subtitle.
  const [hint, setHint] = useState(null);
  const value = useMemo(() => ({ meta, setMeta, hint, setHint }), [meta, hint]);
  return <PageMetaContext.Provider value={value}>{children}</PageMetaContext.Provider>;
}

export function usePageMeta() {
  const ctx = useContext(PageMetaContext);
  if (!ctx) throw new Error("usePageMeta must be used within PageMetaProvider");
  return ctx;
}
