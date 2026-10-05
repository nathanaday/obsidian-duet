import { liveSuite } from './suite.ts';

liveSuite('codex', { approvalPolicy: 'untrusted' }, 'Run this exact shell command: printf hello > note.txt');
