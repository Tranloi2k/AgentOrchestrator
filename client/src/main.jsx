import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { PreferencesProvider } from "./PreferencesContext.jsx";
import { PageMetaProvider } from "./PageMetaContext.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <PreferencesProvider>
        <PageMetaProvider>
          <App />
        </PageMetaProvider>
      </PreferencesProvider>
    </BrowserRouter>
  </React.StrictMode>
);
