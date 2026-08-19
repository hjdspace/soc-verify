// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Mock workbench store
const openMock = vi.fn();
vi.mock('@renderer/stores/workbench', () => ({
  useWorkbenchStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
    selector({ open: openMock }),
  ),
  openFileDestination: vi.fn(),
}));

// Import after mocks
import { Breadcrumb } from '@renderer/components/editor/Breadcrumb';

describe('Breadcrumb', () => {
  it('renders path segments from a Unix-style path', () => {
    render(<Breadcrumb filePath="/projects/my-chip/rtl/tb_subsys/alu_add.sv" />);

    expect(screen.getByText('my-chip')).toBeTruthy();
    expect(screen.getByText('rtl')).toBeTruthy();
    expect(screen.getByText('tb_subsys')).toBeTruthy();
    expect(screen.getByText('alu_add.sv')).toBeTruthy();
  });

  it('renders path segments from a Windows-style path', () => {
    render(<Breadcrumb filePath="C:\\projects\\my-chip\\rtl\\alu_add.sv" />);

    expect(screen.getByText('projects')).toBeTruthy();
    expect(screen.getByText('my-chip')).toBeTruthy();
    expect(screen.getByText('rtl')).toBeTruthy();
    expect(screen.getByText('alu_add.sv')).toBeTruthy();
  });

  it('marks the last segment (filename) as active and not clickable', () => {
    render(<Breadcrumb filePath="/proj/rtl/alu_add.sv" />);

    const lastSegment = screen.getByText('alu_add.sv');
    expect(lastSegment.closest('[data-testid="breadcrumb-active"]')).toBeTruthy();
  });

  it('renders breadcrumb separators between segments', () => {
    render(<Breadcrumb filePath="/proj/rtl/alu_add.sv" />);

    const separators = screen.getAllByText('›');
    expect(separators.length).toBe(3); // 3 separators for 4 segments
  });

  it('calls onNavigate when clicking a non-active segment', () => {
    const onNavigate = vi.fn();
    render(
      <Breadcrumb
        filePath="/proj/rtl/alu_add.sv"
        onNavigate={onNavigate}
      />,
    );

    const rtlSegment = screen.getByText('rtl');
    fireEvent.click(rtlSegment);

    expect(onNavigate).toHaveBeenCalledWith('/proj/rtl');
  });

  it('does not call onNavigate when clicking the last segment (filename)', () => {
    const onNavigate = vi.fn();
    render(
      <Breadcrumb
        filePath="/proj/rtl/alu_add.sv"
        onNavigate={onNavigate}
      />,
    );

    const fileSegment = screen.getByText('alu_add.sv');
    fireEvent.click(fileSegment);

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('calls onNavigate with the correct accumulated path for each segment', () => {
    const onNavigate = vi.fn();
    render(
      <Breadcrumb
        filePath="/proj/rtl/tb_subsys/alu_add.sv"
        onNavigate={onNavigate}
      />,
    );

    // Click 'rtl' → should navigate to /proj/rtl
    fireEvent.click(screen.getByText('rtl'));
    expect(onNavigate).toHaveBeenLastCalledWith('/proj/rtl');

    // Click 'tb_subsys' → should navigate to /proj/rtl/tb_subsys
    fireEvent.click(screen.getByText('tb_subsys'));
    expect(onNavigate).toHaveBeenLastCalledWith('/proj/rtl/tb_subsys');
  });

  it('handles Windows backslash paths for onNavigate', () => {
    const onNavigate = vi.fn();
    render(
      <Breadcrumb
        filePath="C:\\proj\\rtl\\alu_add.sv"
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByText('rtl'));
    // Should preserve backslash separator
    expect(onNavigate).toHaveBeenCalledWith('C:\\proj\\rtl');
  });

  it('renders a single segment for a filename with no directory', () => {
    render(<Breadcrumb filePath="alu_add.sv" />);

    expect(screen.getByText('alu_add.sv')).toBeTruthy();
    // No separators
    expect(screen.queryAllByText('›').length).toBe(0);
  });
});
