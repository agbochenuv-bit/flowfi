import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { useStream } from '../src/react.js';

it('renders loading on the server without starting transport IO', () => {
  const transport = { load: vi.fn(), subscribe: vi.fn() };
  function Balance() {
    return createElement('p', null, useStream(transport, '42', 'wallet').status);
  }
  expect(renderToString(createElement(Balance))).toContain('loading');
  expect(transport.load).not.toHaveBeenCalled();
  expect(transport.subscribe).not.toHaveBeenCalled();
});
