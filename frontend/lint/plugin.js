// Local lint rules (oxlint JS plugin, ESLint's rule API).
export default {
  meta: { name: 'minerva' },
  rules: {
    // The frontend has no component tests: pure logic is tested in *.test.ts, what users see by the browser walk.
    'no-component-tests': {
      meta: { type: 'problem', messages: { component: 'No component tests: test pure modules in *.test.ts (see AGENTS.md, Frontend).' } },
      create(context) {
        if (!context.filename.endsWith('.test.tsx')) return {}
        return { Program: node => context.report({ node, messageId: 'component' }) }
      },
    },
  },
}
