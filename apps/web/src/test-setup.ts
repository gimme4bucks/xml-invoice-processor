import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only cleans up by itself when the test API is global; here it is imported.
afterEach(cleanup);
