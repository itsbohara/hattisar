import { Layout, type Section } from "../layout.js";

export function EmptyPage({
  title,
  section,
  message,
}: {
  title: string;
  section: Section;
  message: string;
}) {
  return (
    <Layout title={title} section={section}>
      <h1>{title}</h1>
      <div class="empty">
        <p>{message}</p>
      </div>
    </Layout>
  );
}
