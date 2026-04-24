// P1 placeholder. Routes, AuthProvider, shell etc. land in P3 / P4.
// We keep the DOM minimal so the warm-neutral background and the display
// serif from styles.css are visible — that's the only assertion P1 needs.
export function App() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "96px",
          fontWeight: 400,
          letterSpacing: "-0.02em",
          margin: 0,
        }}
      >
        Hadir
      </h1>
    </main>
  );
}
