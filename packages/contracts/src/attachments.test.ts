import { describe, expect, it } from 'vitest';
import {
  AttachmentId,
  attachmentMediaType,
  imageSizeRefusal,
  imageTypeRefusal,
} from './attachments.js';
import { Command } from './commands.js';
import { TextItemPayload } from './projections.js';

// Agent workbench spec 53, 54 and Interface: images are named by an id the server gave out.

describe('image attachments', () => {
  it('reads the type from the id and takes no id that could name another file', () => {
    expect(attachmentMediaType('0f8fad5b-d9cb-469f-a165-70867728950e.webp')).toBe('image/webp');
    expect(attachmentMediaType('0f8fad5b-d9cb-469f-a165-70867728950e.jpg')).toBe('image/jpeg');
    for (const id of [
      '../0f8fad5b-d9cb-469f-a165-70867728950e.png',
      '0f8fad5b-d9cb-469f-a165-70867728950e.bmp',
      '0f8fad5b-d9cb-469f-a165-70867728950e.png/x',
      'screenshot.png',
    ]) {
      expect(AttachmentId.safeParse(id).success).toBe(false);
    }
  });

  it('words the refusals with the reason @agent-workbench-54', () => {
    expect(imageTypeRefusal('image/bmp', 'old.bmp')).toBe(
      'old.bmp is a BMP image. Only PNG, JPEG, GIF and WebP images can be sent.',
    );
    expect(imageTypeRefusal('application/pdf')).toBe(
      'This file is application/pdf, not an image. Only PNG, JPEG, GIF and WebP images can be sent.',
    );
    expect(imageSizeRefusal(7_400_000, 5_000_000)).toBe(
      'This image is 7.4 MB; images up to 5 MB can be sent (Settings → Chat, "Largest image").',
    );
  });

  it('keeps older messages and commands valid without images', () => {
    expect(TextItemPayload.parse({ text: 'Hello' })).toEqual({ text: 'Hello' });
    expect(
      Command.safeParse({
        type: 'thread.sendMessage',
        threadId: 't1',
        text: '',
        attachments: [{ id: '0f8fad5b-d9cb-469f-a165-70867728950e.png' }],
      }).success,
    ).toBe(true);
  });
});
