module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  moduleNameMapper: {
    "^@nktkas/hyperliquid/signing$": "<rootDir>/node_modules/@nktkas/hyperliquid/script/signing/mod.js",
  },
  transformIgnorePatterns: [
    "node_modules/(?!(@noble/hashes|@nktkas/hyperliquid)/)",
  ],
  transform: {
    "^.+\\.tsx?$": "ts-jest",
    "^.+\\.jsx?$": "babel-jest",
  },
};
