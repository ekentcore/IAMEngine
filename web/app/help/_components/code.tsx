// Shared code block for the /help setup guides — one styling for every guide page.
export const Code = ({ children }: { children: string }) => (
  <pre style={{ background: "#f6f6f6", border: "1px solid #e2e2e2", borderRadius: 4, padding: "8px 10px", overflowX: "auto", fontSize: 12 }}>
    <code>{children}</code>
  </pre>
);
