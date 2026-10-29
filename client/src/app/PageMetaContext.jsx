import React, { createContext, useContext, useMemo, useState } from "react";

const PageMetaContext = createContext(null);

export function PageMetaProvider({ children }) {
  const [meta, setMeta] = useState(null);
  const value = useMemo(() => ({ meta, setMeta }), [meta]);
  return <PageMetaContext.Provider value={value}>{children}</PageMetaContext.Provider>;
}

export function usePageMeta() {
  const ctx = useContext(PageMetaContext);
  if (!ctx) throw new Error("usePageMeta must be used within PageMetaProvider");
  return ctx;
}
