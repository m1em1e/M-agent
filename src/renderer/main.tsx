import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyAppearancePreferences, createThemeCatalog, loadAppearancePreferences } from "./theme";

// Future plugin startup can pass validated theme contributions into this catalog.
const themePresets = createThemeCatalog();
const initialAppearance = loadAppearancePreferences(window.localStorage, themePresets);
applyAppearancePreferences(initialAppearance, themePresets);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App initialAppearance={initialAppearance} themePresets={themePresets} />
  </React.StrictMode>,
);
