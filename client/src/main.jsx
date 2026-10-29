import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./app/App.jsx";
import { PreferencesProvider } from "./app/PreferencesContext.jsx";
import { PageMetaProvider } from "./app/PageMetaContext.jsx";
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
