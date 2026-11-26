import { analyze } from '../../core/analyze';
import { defineTool } from '../../core/define';

/**
 * The home page's automatic analysis, as a tool so that it runs in the worker and can be stopped
 * like any other (Runner.cancel). Hidden: it is not in the catalog, the search or the triage
 * ranking; the home page calls it by id and draws its one `analysis` output as a layered report.
 */
export default defineTool({
  id: 'analyze',
  name: 'Analyze',
  category: 'forensics',
  description: 'Identify a file, unwrap what it contains and report what it hides.',
  hidden: true,
  input: 'bytes',
  live: false,
  examples: [
    {
      label: 'Nested archive',
      input: { sample: 'extract-nested.zip' },
      expect: 'FTF{extract_unwraps_layers}',
    },
  ],
  async run(input) {
    return [{ type: 'analysis', result: await analyze(input.bytes, input.name) }];
  },
});
