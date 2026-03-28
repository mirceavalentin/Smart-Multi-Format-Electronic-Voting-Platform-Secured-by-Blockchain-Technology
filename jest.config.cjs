/** @type {import('jest').Config} */
const common = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.json",
      },
    ],
  },
  setupFilesAfterEnv: ["<rootDir>/tests/jest.setup.ts"],
  clearMocks: true,
};

module.exports = {
  projects: [
    {
      ...common,
      displayName: "unit",
      testMatch: ["<rootDir>/tests/unit/**/*.test.ts"],
    },
    {
      ...common,
      displayName: "integration",
      testMatch: ["<rootDir>/tests/integration/**/*.test.ts"],
    },
  ],
};
