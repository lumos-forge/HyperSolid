# gridLimit 对称双边（mobile 模板）实现计划 — 子项目 2b

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 mobile AgentScreen 的 gridLimit 模板暴露 `mode: longOnly | symmetric` 分段控件并透传给 server（2a 已实现的契约）。

**Architecture:** 完全镜像已上线的 grid 对称模式开关（`grid` 模板已有的 `gridMode` state + 分段控件），作用到 `gridLimit` 模板。无新概念、无新组件、无新 i18n key。

**Tech Stack:** Expo RN + TypeScript + Zustand + jest-expo + @testing-library/react-native。

参考 spec：`docs/superpowers/specs/2026-07-08-gridlimit-symmetric-mobile-design.md`

---

### Task 1: gridLimit 模板 mode 分段控件 + 透传

**Files:**
- Modify: `mobile/src/services/strategyApi.ts:18-20`（`GridLimitParams` 加 `mode`）
- Modify: `mobile/src/screens/AgentScreen.tsx`（`glMode` state ~line 162 邻近；gridLimit 模板 ~line 389-401；`onCreateGridLimit` ~line 217-225）
- Test: `mobile/src/screens/AgentScreen.test.tsx`（既有 gridLimit 创建用例 ~line 201-215 更新 + 新增对称用例）

参考已存在的 grid 实现（**镜像它**）：
- `strategyApi.ts` `GridParams` 已有 `mode?: "longOnly" | "symmetric";`（line 16）。
- AgentScreen `gridMode` state（line 162）、grid 模板 mode 分段控件（line 365-382）、`onCreateGrid` 传 `mode: gridMode`（line 213）。
- i18n key 已存在（en+zh）：`agent.gridMode`、`agent.gridModeLongOnly`、`agent.gridModeSymmetric`。

- [ ] **Step 1: 写失败测试（更新既有用例 + 新增对称用例）**

在 `mobile/src/screens/AgentScreen.test.tsx` 中，把既有「switches to the Limit grid template and creates one」用例的断言改为包含 `mode: "longOnly"`：

```tsx
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50, mode: "longOnly" }),
    );
```

紧接其后新增对称用例（镜像 grid 的 "creates a symmetric grid" 用例）：

```tsx
  it("creates a symmetric limit grid when the symmetric mode is selected", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("template-gridLimit")).toBeTruthy());
    fireEvent.press(screen.getByTestId("template-gridLimit"));
    fireEvent.changeText(screen.getByTestId("grid-limit-coin"), "BTC");
    fireEvent.changeText(screen.getByTestId("grid-limit-lower"), "100");
    fireEvent.changeText(screen.getByTestId("grid-limit-upper"), "200");
    fireEvent.changeText(screen.getByTestId("grid-limit-levels"), "6");
    fireEvent.changeText(screen.getByTestId("grid-limit-per-level"), "50");
    fireEvent.press(screen.getByTestId("grid-limit-mode-symmetric"));
    fireEvent.press(screen.getByTestId("grid-limit-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50, mode: "symmetric" }),
    );
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx -t "limit grid"`
Expected: FAIL — 既有用例因 payload 缺 `mode` 不匹配；新对称用例因找不到 `grid-limit-mode-symmetric` testID 而失败。

- [ ] **Step 3: `GridLimitParams` 加 `mode`**

在 `mobile/src/services/strategyApi.ts` 把：

```ts
export interface GridLimitParams {
  coin: string; lowerPrice: number; upperPrice: number; levels: number; perLevelUsdc: number;
}
```

改为：

```ts
export interface GridLimitParams {
  coin: string; lowerPrice: number; upperPrice: number; levels: number; perLevelUsdc: number;
  mode?: "longOnly" | "symmetric";
}
```

- [ ] **Step 4: AgentScreen 加 `glMode` state**

在 `mobile/src/screens/AgentScreen.tsx` 紧邻 `const [gridMode, setGridMode] = useState<"longOnly" | "symmetric">("longOnly");`（line 162）之后加：

```tsx
  const [glMode, setGlMode] = useState<"longOnly" | "symmetric">("longOnly");
```

- [ ] **Step 5: `onCreateGridLimit` 透传 mode**

把 `onCreateGridLimit`（line 223）的调用：

```tsx
    await ctrl.createGridLimit({ coin: coin.toUpperCase(), lowerPrice: lower, upperPrice: upper, levels, perLevelUsdc: perLevel });
```

改为：

```tsx
    await ctrl.createGridLimit({ coin: coin.toUpperCase(), lowerPrice: lower, upperPrice: upper, levels, perLevelUsdc: perLevel, mode: glMode });
```

- [ ] **Step 6: gridLimit 模板插入 mode 分段控件**

在 gridLimit 模板（line 389-401）里，`grid-limit-per-level` 字段与 `grid-limit-create` 按钮之间插入（镜像 grid 的 line 365-382，改 testID 前缀与 state）：

```tsx
          <Field theme={theme} label={t("agent.gridPerLevel")} value={glPerLevel} onChangeText={setGlPerLevel} keyboard testID="grid-limit-per-level" />
          <View style={styles.sideRow}>
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>{t("agent.gridMode")}</Text>
            <View style={styles.sideBtns}>
              {(["longOnly", "symmetric"] as const).map((m) => (
                <Pressable
                  key={m}
                  testID={`grid-limit-mode-${m}`}
                  accessibilityRole="button"
                  onPress={() => setGlMode(m)}
                  style={[styles.sideBtn, { borderColor: theme.line }, glMode === m && { backgroundColor: theme.surface }]}
                >
                  <Text style={[styles.segmentText, { color: glMode === m ? theme.text : theme.muted }]}>
                    {t(m === "longOnly" ? "agent.gridModeLongOnly" : "agent.gridModeSymmetric")}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
```

（即在既有 per-level `Field` 之后、`Pressable ... grid-limit-create` 之前插入这段 `View`。）

- [ ] **Step 7: 运行目标测试确认通过**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx -t "limit grid"`
Expected: PASS（既有 longOnly 用例 + 新对称用例均通过）。

- [ ] **Step 8: 全量门禁**

Run: `cd mobile && npx tsc --noEmit && npx jest && npx jest noHardcodedColors && npx jest messages`
Expected: tsc 干净；jest 全通过（基线 +1 用例）；noHardcodedColors 通过（未引入 hex）；messages 通过（未新增/删除 i18n key）。

- [ ] **Step 9: 提交**

```bash
git add mobile/src/services/strategyApi.ts mobile/src/screens/AgentScreen.tsx mobile/src/screens/AgentScreen.test.tsx
git commit --no-verify -m "feat(mobile): symmetric mode toggle for gridLimit template (2b)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage：**
- `GridLimitParams.mode` → Step 3 ✅
- `glMode` state + 分段控件 + 透传 → Steps 4/5/6 ✅
- i18n 复用（无新增 key）→ 无需 task，Step 6 直接引用现有 key ✅
- 运行卡片不显示模式 → 非目标，无 task ✅
- 测试（更新既有 + 新增对称）→ Step 1 ✅

**Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整代码。

**Type consistency：** `mode?: "longOnly" | "symmetric"` 与 `GridParams`、server 契约一致；testID `grid-limit-mode-{m}` 与测试 Step 1 引用一致；state `glMode`/`setGlMode` 全程一致。
