// A text file dropped or pasted on the composer (chat overview spec 35): its text as a fenced
// block headed by its name, which the message carries as written. The fence is longer than any
// run of backticks inside, so the block ends where the file does.

const pdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/iu.test(file.name);

export async function textFileBlock(
  file: File,
  maxBytes: number,
): Promise<string | { readonly refused: string }> {
  const name = file.name === '' ? 'pasted file' : file.name;
  if (pdf(file)) {
    return {
      refused: `${name} is a PDF, which wow cannot put in a message yet. Paste the part you need as text.`,
    };
  }
  if (file.size > maxBytes) {
    return {
      refused: `${name} is ${file.size.toLocaleString('en')} bytes; a text file in a message can be up to ${maxBytes.toLocaleString('en')} (Largest text file in a message).`,
    };
  }
  const text = await file.text();
  if (text.includes('\0') || text.includes('�')) {
    return { refused: `${name} is not a text file wow can put in a message.` };
  }
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map((run) => run[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${name}\n${text.replace(/\n$/u, '')}\n${fence}`;
}
