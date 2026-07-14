import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Cool-neutral surface hierarchy. The page bg sits a clear step below
        // white so cards separate by CONTRAST + soft elevation, not by a mushy
        // hairline border on near-white (the old #f8fafd/#fff pairing).
        drive: {
          bg: "#eaeef4",        // page — cool light gray, clearly below white
          panel: "#ffffff",     // cards float on bg
          sidebar: "#f2f5f9",   // distinct rail, between bg and panel
          hover: "#e2e8f1",     // hover feedback on light surfaces
          selected: "#d8e6ff",  // soft blue selection (was a harsh #c2e7ff)
          border: "#dce3ec",    // quiet cool hairline — separation comes from bg+shadow
          text: "#0f1319",      // near-black, high contrast
          muted: "#54607a",     // cool gray, darker than #5f6368 for legibility
          accent: "#0b57d0",    // confident, accessible blue
          accentHover: "#0842a0",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      fontSize: {
        display: ["28px", { lineHeight: "1.2", fontWeight: "600" }],
        title: ["20px", { lineHeight: "1.3", fontWeight: "600" }],
        subtitle: ["16px", { lineHeight: "1.4", fontWeight: "500" }],
        body: ["14px", { lineHeight: "1.5" }],
        caption: ["12px", { lineHeight: "1.4" }],
        label: ["11px", { lineHeight: "1.3", fontWeight: "500", letterSpacing: "0.04em" }],
      },
      borderRadius: { sm: "6px", md: "8px", lg: "12px", xl: "16px" },
      boxShadow: {
        // Cool slate-toned, soft elevation — cards float on the gray bg without
        // the heavy warm-gray drop shadow of the old Drive look.
        drive: "0 1px 2px -1px rgb(15 23 42 / 0.08), 0 6px 16px -6px rgb(15 23 42 / 0.12)",
        e1: "0 1px 2px 0 rgb(15 23 42 / 0.06)",
        e2: "0 2px 4px -1px rgb(15 23 42 / 0.08), 0 6px 16px -6px rgb(15 23 42 / 0.10)",
        e3: "0 8px 24px -8px rgb(15 23 42 / 0.16), 0 16px 40px -12px rgb(15 23 42 / 0.12)",
      },
    },
  },
  plugins: [],
};

export default config;
