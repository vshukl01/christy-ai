// lib/downloadChatpdf.ts
import jsPDF from "jspdf";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export default function downloadChatAsPdf(messages: ChatMessage[]) {
  const doc = new jsPDF({
    unit: "pt",
    format: "a4",
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const marginLeft = 40;
  const marginTop = 40;
  const contentWidth = pageWidth - marginLeft * 2;
  const lineHeight = 14;

  let y = marginTop;

  // Helper: add a new page if there isn't enough space
  const addPageIfNeeded = (neededLines: number) => {
    const remaining = pageHeight - y - marginTop;
    const neededHeight = neededLines * lineHeight;

    if (neededHeight > remaining) {
      doc.addPage();
      y = marginTop;
    }
  };

  messages.forEach((msg, index) => {
    const speaker = msg.role === "user" ? "You" : "Christy";

    const header = `${speaker} (${index + 1})`;

    // Split message body into wrapped lines (typed as string[])
    const bodyLines: string[] = doc.splitTextToSize(
      msg.content.trim(),
      contentWidth
    ) as string[];

    // Header + body + a blank line
    addPageIfNeeded(bodyLines.length + 2);

    // Header
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(header, marginLeft, y);
    y += lineHeight;

    // Body
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);

    bodyLines.forEach((line) => {
      doc.text(line, marginLeft, y);
      y += lineHeight;
    });

    // Extra blank line between messages
    y += lineHeight;
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  doc.save(`christy_chat_${dateStr}.pdf`);
}
