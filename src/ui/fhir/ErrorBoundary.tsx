/**
 * The smallest possible blast radius for a bad resource.
 *
 * A white page is a product failure for a tool whose promise is to explain. The
 * incumbent viewer has no error boundary anywhere, so one `DocumentReference`
 * with no `content` throws a TypeError that blanks the whole page: the reader
 * concludes the tool is broken, or worse, that the payload is empty.
 *
 * So this is wrapped at three granularities, and the `unit` prop says which:
 * a section, a table inside a section, and a single row. One bad resource costs
 * one row, and the row says so rather than disappearing, because a row that
 * disappears is indistinguishable from a resource the server never sent.
 *
 * A class component, because `getDerivedStateFromError` has no hook equivalent.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Callout, CodeBlock, Disclosure } from '../primitives';

export type FailureUnit = 'section' | 'table' | 'row';

export interface ErrorBoundaryProps {
  /** What failed, in the reader's own words: "the Medications section". */
  label: string;
  unit?: FailureUnit;
  /**
   * The resource or element being rendered when it broke. Offered as JSON so the
   * reader can see the input that defeated the renderer, which is the only thing
   * that makes this actionable for whoever produced the payload.
   */
  subject?: unknown;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | undefined;
}

const UNIT_WORD: Record<FailureUnit, string> = {
  section: 'section',
  table: 'table',
  row: 'row',
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: undefined };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only sink available, and it is the one place a
    // developer standing at the laptop will look. Nothing is sent anywhere.
    console.error(`Loupe could not render ${this.props.label}`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) return this.props.children;
    const unit = UNIT_WORD[this.props.unit ?? 'row'];
    return (
      <div className="render-failure">
        <Callout tone="exception" title={`This ${unit} could not be rendered`}>
          <p className="render-failure-text">
            {this.props.label} defeated the renderer, so Loupe is showing this instead of dropping
            it. Everything else on this page rendered normally. The error was:{' '}
            <span className="mono">{error.message}</span>
          </p>
          {this.props.subject !== undefined && (
            <Disclosure summary="What it was asked to render">
              <CodeBlock language="json">{safeJson(this.props.subject)}</CodeBlock>
            </Disclosure>
          )}
        </Callout>
      </div>
    );
  }
}

/**
 * A payload can carry a cycle (a contained resource referring back to its
 * container), and `JSON.stringify` throws on one. Failing to serialise the thing
 * that broke the renderer, inside the fallback for the renderer breaking, would
 * be the one bug with nowhere left to report itself.
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'This value could not be serialised as JSON, which is usually a circular reference.';
  }
}
