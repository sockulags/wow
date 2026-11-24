import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HostLink } from './host-read';

// What a host gave as a link opens only when it is a web address. All invented.

describe('a link the host gave', () => {
  it('is a link only for a web address', () => {
    render(
      <>
        <HostLink href="https://ghe.example.invalid/acme/tea/pull/14">#14</HostLink>
        <HostLink href="javascript:alert(document.domain)">#15</HostLink>
        <HostLink href="file:///C:/Windows/System32/calc.exe">#16</HostLink>
      </>,
    );
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['#14']);
    expect(screen.getByText('#15').closest('a')).toBeNull();
    expect(screen.getByText('#16').closest('a')).toBeNull();
  });
});
