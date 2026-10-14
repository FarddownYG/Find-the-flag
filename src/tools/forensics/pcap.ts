import { bool, defineTool, number, select, text } from '../../core/define';
import { ToolError } from '../../core/errors';
import { analyze } from './_pcap-analyze';
import { looksLikeCapture } from './_pcap-read';
import { render } from './_pcap-render';

const inMode = (values: Record<string, unknown>, ...modes: string[]) =>
  modes.includes(String(values.mode));

export default defineTool({
  id: 'pcap',
  name: 'PCAP analyzer',
  category: 'forensics',
  description:
    'Open a .pcap or .pcapng capture: follow TCP streams, export HTTP/FTP files, find credentials, DNS and flags.',
  tags: [
    'wireshark',
    'tshark',
    'pcap',
    'pcapng',
    'network',
    'capture',
    'packets',
    'follow tcp stream',
    'export objects',
    'http',
    'dns',
    'ftp',
    'icmp',
    'exfiltration',
    'networkminer',
  ],
  input: 'bytes',
  placeholder: 'Drop a .pcap or .pcapng capture (Wireshark, tcpdump, tshark)',
  options: {
    mode: select(
      'Mode',
      [
        { value: 'overview', label: 'Overview' },
        { value: 'streams', label: 'Follow streams' },
        { value: 'export', label: 'Export objects' },
        { value: 'packets', label: 'Packets' },
        { value: 'exfil', label: 'ICMP/DNS exfil' },
      ],
      'overview',
    ),
    filter: text('Filter', '', {
      placeholder: '10.0.0.5 http flag',
      hint: 'Words that must all match (IP, port, protocol, text). Streams also search their content.',
      showIf: (v) => inMode(v, 'streams', 'export', 'packets'),
    }),
    stream: number('Stream', -1, {
      min: -1,
      hint: '-1 lists the streams and shows the first ones; a number shows only that stream (see the # column).',
      showIf: (v) => inMode(v, 'streams'),
    }),
    limit: number('Streams shown', 5, {
      min: 1,
      max: 200,
      hint: 'How many conversations to print when Stream is -1.',
      showIf: (v) => inMode(v, 'streams'),
    }),
    view: select(
      'View',
      [
        { value: 'ascii', label: 'ASCII' },
        { value: 'utf8', label: 'UTF-8' },
        { value: 'hex', label: 'Hex dump' },
      ],
      'ascii',
      { showIf: (v) => inMode(v, 'streams') },
    ),
    domainLabels: number('Domain labels', 2, {
      min: 1,
      max: 6,
      hint: 'Labels of the attacker domain kept from the right (2 for data.evil.example); the rest is the payload.',
      showIf: (v) => inMode(v, 'exfil'),
    }),
    sortSeq: bool('Sort ICMP by sequence', false, {
      hint: 'Order echo payloads by their ICMP sequence number instead of capture order.',
      showIf: (v) => inMode(v, 'exfil'),
    }),
  },
  examples: [
    {
      label: 'Overview: find the flag',
      input: { sample: 'forensics-http.pcap' },
      expect: 'flag{follow_the_stream}',
    },
    {
      label: 'Follow the HTTP stream',
      input: { sample: 'forensics-http.pcap' },
      options: { mode: 'streams', stream: 0 },
      expect: 'GET /secret.txt HTTP/1.1',
    },
    {
      label: 'Export the downloaded file',
      input: { sample: 'forensics-http.pcap' },
      options: { mode: 'export' },
      expect: 'secret.txt',
    },
    {
      label: 'FTP password in the clear',
      input: { sample: 'forensics-http.pcap' },
      expect: 'hunter2',
    },
    {
      label: 'Packet list, DNS only',
      input: { sample: 'forensics-http.pcap' },
      options: { mode: 'packets', filter: 'dns' },
      expect: 'Standard query',
    },
    {
      label: 'ICMP exfiltration (pcapng)',
      input: { sample: 'forensics-exfil.pcapng' },
      options: { mode: 'exfil' },
      expect: 'flag{icmp_exfil}',
    },
  ],
  run({ bytes }, opts) {
    if (!bytes.length) {
      throw new ToolError('Drop a .pcap or .pcapng file here (a binary capture, not pasted text).');
    }
    const analysis = analyze(bytes);
    return render(analysis, {
      mode: opts.mode,
      filter: opts.filter,
      stream: Math.trunc(Number.isFinite(opts.stream) ? opts.stream : -1),
      limit: Math.min(200, Math.max(1, Math.trunc(opts.limit) || 5)),
      view: opts.view,
      domainLabels: Math.min(6, Math.max(1, Math.trunc(opts.domainLabels) || 2)),
      sortSeq: opts.sortSeq,
    });
  },
  detect({ bytes }) {
    return looksLikeCapture(bytes) ? { score: 0.95, reason: 'pcap/pcapng capture' } : null;
  },
});
