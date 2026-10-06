import { liveSuite } from './suite.ts';

liveSuite(
  'codex',
  { approvalPolicy: 'untrusted' },
  'Run this exact shell command: printf hello > note.txt',
  'Create the file note.txt containing exactly: hello. Use apply_patch, not a shell command.',
);
