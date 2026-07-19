import "@testing-library/jest-dom/vitest";

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});
