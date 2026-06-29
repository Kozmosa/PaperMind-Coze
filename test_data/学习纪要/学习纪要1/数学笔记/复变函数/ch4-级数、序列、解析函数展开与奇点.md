
## 1. 级数和序列的基本性质

### 1.1 复数列和极限

复数项级数定义为无穷和

$\sum_{n=1}^{\infty} z_n = z_1 + z_2 + \cdots + z_n + \cdots$

若部分和序列 $S_n = z_1 + z_2 + \cdots + z_n$ 收敛，则称级数收敛，该极限称为级数的和。

#### 柯西收敛原理（级数形式）

$\sum z_n \text{ 收敛 } \iff \forall \varepsilon > 0, \exists N, \text{ 使得 } n > N \text{ 时 } \forall p \geq 1, \; |z_{n+1} + z_{n+2} + \cdots + z_{n+p}| < \varepsilon$

**证明思路**：必要性由部分和序列的柯西性直接得到；充分性通过构造极限点并证明唯一性。

#### 柯西收敛原理（序列形式）

序列 $\{z_n\}$ 收敛 $\iff$ $\forall \varepsilon>0, \exists N$，当 $m,n > N$ 时有 $|z_m - z_n| < \varepsilon$。

> 💡 **批注**：原笔记中“$z_n \to 0$”是笔误，应为“$\forall \varepsilon>0$”。

#### 绝对收敛与条件收敛

- **绝对收敛**：$\sum |z_n|$ 收敛。
- **条件收敛**：$\sum z_n$ 收敛但 $\sum |z_n|$ 发散。

#### 重排

绝对收敛级数的重排不改变其和；条件收敛级数的重排可以改变其和（黎曼重排定理）。

> 💡 **批注**：原笔记“重排可删改变部分收敛级数目的和”应为“重排可改变条件收敛级数的和”。

### 1.2 柯西乘积

称级数 $\sum_{n=0}^{\infty} c_n$ 为级数 $\sum a_n$ 与 $\sum b_n$ 的柯西乘积，其中

$c_n = a_0 b_n + a_1 b_{n-1} + \cdots + a_n b_0 = \sum_{k=0}^{n} a_k b_{n-k}$.

#### 应用：两个幂级数相乘

$\left( \sum_{n=0}^{\infty} \alpha_n z^n \right) \left( \sum_{n=0}^{\infty} \beta_n z^n \right)
= \alpha_0 \beta_0 + (\alpha_0 \beta_1 + \alpha_1 \beta_0) z + (\alpha_0 \beta_2 + \alpha_1 \beta_1 + \alpha_2 \beta_0) z^2 + \cdots$

#### 柯西乘积定理

设 $\sum \alpha_n$ 及 $\sum \beta_n$ 绝对收敛，其和分别为 $A$ 和 $B$，则柯西乘积级数 $\sum_{n=0}^{\infty} c_n$ 也绝对收敛，且和为 $A \cdot B$。

**证明**：考虑部分和 $C_N = \sum_{n=0}^N c_n = \sum_{i=0}^N \sum_{j=0}^{N-i} a_i b_j$。令 $A_N = \sum_{i=0}^N a_i$，$B_N = \sum_{j=0}^N b_j$，则 $A_N B_N = \sum_{i=0}^N \sum_{j=0}^N a_i b_j = C_N + \sum_{i=0}^N \sum_{j=N-i+1}^N a_i b_j$。利用绝对收敛性可证余项趋于 $0$，故 $C_N \to AB$。绝对收敛性由 $|c_n| \le \sum_{k=0}^n |a_k||b_{n-k}|$ 及 Cauchy 卷积的收敛性保证。

- 若一个级数绝对收敛，另一个条件收敛，则柯西乘积收敛到两和之积。
- 若两个级数都条件收敛，则柯西乘积可能发散。

> 💡 **批注**：原笔记中“6 和 6'”应为“A 和 B”。柯西乘积的收敛性需要至少一个绝对收敛才能保证。

---

## 2. 复变函数项级数和序列

- **级数**：$f_1(z) + f_2(z) + \cdots + f_n(z) + \cdots$
- **序列**：$g_1(z), g_2(z), \cdots, g_n(z), \cdots$

### 点点收敛

对于每个 $z \in E$，若 $\lim_{n\to\infty} \sum_{k=1}^n f_k(z) = S(z)$，则称级数在 $E$ 上点点收敛到 $S(z)$。

### 一致收敛

称 $\sum f_n(z)$ 在 $E$ 上一致收敛到 $S(z)$，若

$\forall \varepsilon > 0, \exists N, \text{ 当 } n > N \text{ 时 } \left| \sum_{k=n+1}^{\infty} f_k(z) - S(z) \right| < \varepsilon, \quad \forall z \in E$.

> 💡 **批注**：原笔记中“$\sum_{k=n+1}^N$”应为无穷和，实际上是余项估计。

### 一致收敛判别法

#### 柯西一致收敛原理

函数项级数 $\sum f_n(z)$（或序列 $g_n(z)$）在 $E$ 上一致收敛的充要条件是：$\forall \varepsilon>0, \exists N$，当 $n \ge N$ 时，$\forall p \ge 1, \forall z \in E$ 有

$|f_{n+1}(z) + \cdots + f_{n+p}(z)| < \varepsilon$ （或 $|g_n(z) - g_{n+p}(z)| < \varepsilon$）.

**证明**：必要性由定义直接推出；充分性利用对每个固定 $z$ 的 Cauchy 条件得到逐点极限 $S(z)$，再证明一致收敛。

#### 魏尔斯特拉斯一致收敛判别法（M-判别法）

若对任意 $z \in E$ 有 $|f_n(z)| \le a_n$，且 $\sum a_n$ 收敛，则 $\sum f_n(z)$ 在 $E$ 上一致收敛。

**证明**：由 $\sum a_n$ 收敛知 $\forall \varepsilon>0, \exists N$ 使得 $n>N$ 时 $\sum_{k=n+1}^{n+p} a_k < \varepsilon$，从而 $|\sum_{k=n+1}^{n+p} f_k(z)| \le \sum_{k=n+1}^{n+p} |f_k(z)| \le \sum_{k=n+1}^{n+p} a_k < \varepsilon$，由 Cauchy 一致收敛原理得证。

### 一致收敛的性质

**定理 2.1（连续性）**  
设 $f_n(z)$（或 $g_n(z)$）在集合 $E$ 上连续，且在 $E$ 上一致收敛到 $S(z)$（或 $g(z)$），则 $S(z)$（或 $g(z)$）在 $E$ 上连续。

**证明**：对任意 $z_0 \in E$，$|S(z)-S(z_0)| \le |S(z)-f_n(z)| + |f_n(z)-f_n(z_0)| + |f_n(z_0)-S(z_0)|$。一致收敛性控制第一和第三项，连续性控制第二项。

**定理 2.2（积分交换）**  
若在可求长曲线 $C$ 上，$\sum f_n(z)$ 一致收敛到 $S(z)$，则

$\sum_{n=1}^{\infty} \int_C f_n(z) dz = \int_C S(z) dz$.

**证明**：由一致收敛性，$\left| \int_C S(z) dz - \sum_{n=1}^N \int_C f_n(z) dz \right| = \left| \int_C (S(z) - \sum_{n=1}^N f_n(z)) dz \right| \le \text{长度}(C) \cdot \sup_{z\in C} |S(z)-\sum_{n=1}^N f_n(z)| \to 0$。

**定理 2.3（魏尔斯特拉斯定理，求导与极限交换）**  
设 $f_n(z)$（或 $g_n(z)$）在区域 $D$ 上解析，且 $\sum f_n(z)$（或 $g_n(z)$）在 $D$ 上**内闭一致收敛**到 $S(z)$（或 $g(z)$），则对任意 $k \ge 1$，$S^{(k)}(z)$ 存在且

$S^{(k)}(z) = \sum_{n=1}^{\infty} f_n^{(k)}(z)$,

且该级数也在 $D$ 上内闭一致收敛。

**证明**：先对 $k=1$ 证明。任取 $z_0 \in D$，取圆盘 $B(z_0,r) \subset D$。由柯西积分公式，$f_n'(z) = \frac{1}{2\pi i} \int_{|\zeta-z_0|=r} \frac{f_n(\zeta)}{(\zeta-z)^2} d\zeta$。利用一致收敛性交换求和与积分，得到 $S'(z) = \sum f_n'(z)$。高阶导数由归纳法得到。

> 💡 **批注**：内闭一致收敛是指在任意紧子集上一致收敛。原笔记“内同一致收敛”应为“内闭一致收敛”。

---

## 3. Gamma 函数

Gamma 函数是阶乘在复数域上的推广。

### 极限定义（欧拉）

$\Gamma(z) = \lim_{n \to \infty} \frac{n! \, n^z}{z(z+1)\cdots(z+n)}, \quad z \in \mathbb{C} \setminus \{0, -1, -2, \dots\}$.

当 $z = k$（正整数）时，

$\Gamma(k) = (k-1)!$.

> 💡 **批注**：原笔记中“$O! = 1$”正确，但“$z=kz$”是笔误。

### 积分定义

$\Gamma(z) = \int_0^{\infty} e^{-t} t^{z-1} dt, \quad \operatorname{Re} z > 0$.

### 递推性质

$\Gamma(z+1) = z \Gamma(z) \quad \Rightarrow \quad \Gamma(n) = (n-1)!$.

**证明**（积分定义）：$\Gamma(z+1) = \int_0^\infty e^{-t} t^{z} dt = [-e^{-t}t^{z}]_0^\infty + z\int_0^\infty e^{-t} t^{z-1} dt = z\Gamma(z)$。

### 余元公式

$\Gamma(z) \Gamma(1-z) = \frac{\pi}{\sin \pi z}, \quad z \notin \mathbb{Z}$.

由此可得 $\Gamma\left(\frac{1}{2}\right) = \sqrt{\pi}$.

> 💡 **批注**：原笔记中“$\Gamma(z) = \text{斤}$”是乱码，应为“$\Gamma(1/2)=\sqrt{\pi}$”。

### Gamma 函数解析性的证明

**原笔记推导整理**：设 $\Gamma_n(z) = \frac{n! n^z}{z(z+1)\cdots(z+n)}$，考虑 $\ln \Gamma_n(z)$。计算 $\ln \frac{\Gamma_{n+1}(z)}{\Gamma_n(z)} = \ln \frac{(n+1)^z}{n^z} + \ln \frac{n+1}{z+n+1}$。利用 $\ln(1+u)$ 的展开和积分估计，可得

$\left| \ln \frac{\Gamma_{n+1}(z)}{\Gamma_n(z)} \right| \le \frac{C}{n^2}$（对 $z$ 在紧集上一致）。因此 $\sum \ln \frac{\Gamma_{n+1}}{\Gamma_n}$ 一致收敛，从而 $\Gamma_n(z)$ 在紧集上一致收敛到 $\Gamma(z)$，且每个 $\Gamma_n(z)$ 是亚纯函数，极限函数 $\Gamma(z)$ 在 $\mathbb{C}\setminus\{0,-1,-2,\dots\}$ 上解析。

> 💡 **标准证明补充**：更常见的做法是证明 Weierstrass 无穷乘积 $\frac{1}{\Gamma(z)} = z e^{\gamma z} \prod_{n=1}^\infty \left(1+\frac{z}{n}\right) e^{-z/n}$ 在复平面上一致收敛，从而 $\Gamma(z)$ 解析。

---

## 4. 魏尔斯特拉斯函数（处处连续处处不可微）

$f(x) = \sum_{n=0}^{\infty} \frac{\cos(3^n x)}{2^n}$

该级数在 $\mathbb{R}$ 上一致收敛（由 M-判别法，$|\cos(3^n x)/2^n| \le 1/2^n$），故 $f(x)$ 连续。证明不可微需要构造差商的下界（原笔记未给出完整证明）。

在复平面上，若 $z = x + iy$ 且 $y \neq 0$，则

$\left| \frac{\cos(3^n z)}{2^n} \right| \sim \frac{e^{3^n |y|}}{2^{n+1}} \to \infty$,

所以级数在复平面任何区域都不内闭一致收敛。

> 💡 **批注**：原笔记中“魏尔斯特拉斯函数：处处连续处处不可微”是实数情形，复平面上仅在实轴收敛。

---

## 5. 幂级数

幂级数形式：$\sum_{n=0}^{\infty} a_n (z - z_0)^n$.

### 阿贝尔定理（1826）

**定理 3.1**：若幂级数在 $z_1$ 处收敛，则对任意满足 $|z_2 - z_0| < |z_1 - z_0|$ 的 $z_2$，幂级数在 $z_2$ 处绝对收敛。

**证明**：由 $\sum a_n (z_1-z_0)^n$ 收敛知 $|a_n (z_1-z_0)^n| \le M$。则 $|a_n (z_2-z_0)^n| = |a_n (z_1-z_0)^n| \cdot \left|\frac{z_2-z_0}{z_1-z_0}\right|^n \le M r^n$，其中 $r<1$，故绝对收敛。

**定理 3.2**：设幂级数的收敛半径为 $R$，则当 $|z - z_0| < R$ 时绝对收敛，当 $|z - z_0| > R$ 时发散。

**证明**：定义 $R = \sup\{ |z-z_0| : \text{级数在 } z \text{ 收敛} \}$，由阿贝尔定理直接推出。

### 收敛半径的计算公式

$R = \frac{1}{\limsup_{n\to\infty} |a_n|^{1/n}}$ 或 $R = \lim_{n\to\infty} \left| \frac{a_n}{a_{n+1}} \right|$ （若极限存在）.

**证明**（根值法）：由根值判别法，当 $\limsup |a_n|^{1/n} |z-z_0| < 1$ 时绝对收敛，$>1$ 时发散，故 $R = 1/\limsup |a_n|^{1/n}$。比值法可由 $\lim |a_{n+1}/a_n|$ 存在时与根值法等价推出。

> 💡 **批注**：原笔记中“$l = \lim \frac{|a_{n+1}|}{|a_n|}$”是比值法，但需注意极限可能不存在，此时用根值法。

### 幂级数的和函数与逐项求导

幂级数在其收敛圆盘 $|z - z_0| < R$ 上内闭一致收敛，和函数 $f(z)$ 解析，且可逐项求导：

$f^{(n)}(z) = n! a_n + \frac{(n+1)!}{1!} a_{n+1} (z - z_0) + \frac{(n+2)!}{2!} a_{n+2} (z - z_0)^2 + \cdots$

**证明**：由一致收敛性及内闭一致收敛求导定理（定理2.3）直接得到。

---

## 6. 泰勒展式

**定理 4.1**：设 $f$ 在圆盘 $U(z_0, R)$ 上解析，则对任意 $z \in U(z_0, R)$，有

$f(z) = \sum_{n=0}^{\infty} \frac{f^{(n)}(z_0)}{n!} (z - z_0)^n$.

### 证明

取 $r$ 满足 $|z-z_0| < r < R$。由柯西积分公式，

$f(z) = \frac{1}{2\pi i} \int_{|\zeta - z_0| = r} \frac{f(\zeta)}{\zeta - z} d\zeta$.

将 $\frac{1}{\zeta - z} = \frac{1}{\zeta - z_0} \cdot \frac{1}{1 - \frac{z - z_0}{\zeta - z_0}} = \sum_{n=0}^{\infty} \frac{(z - z_0)^n}{(\zeta - z_0)^{n+1}}$，该级数对 $|\zeta - z_0|=r$ 一致收敛（因为 $|z-z_0|/r < 1$）。交换积分与求和得

$f(z) = \sum_{n=0}^{\infty} \left( \frac{1}{2\pi i} \int_{|\zeta - z_0| = r} \frac{f(\zeta)}{(\zeta - z_0)^{n+1}} d\zeta \right) (z - z_0)^n$，

而括号内正是 $\frac{f^{(n)}(z_0)}{n!}$。

### 例子

$\frac{1}{1 - z} = \sum_{n=0}^{\infty} z^n, \quad |z| < 1$.

### 幂级数展开的充要条件

**定理 4.2**：$f(z)$ 在 $z_0$ 某邻域内可展开为幂级数 $\iff$ $f(z)$ 在 $z_0$ 解析。

**证明**：充分性由定理4.1；必要性：幂级数在其收敛圆内解析（逐项求导后仍为幂级数），故和函数解析。

> 💡 **批注**：实数域中 $f(x)=e^{-1/x^2}$（$x\neq0$），$f(0)=0$ 虽然任意阶可导，但泰勒级数恒为零，不收敛到原函数。这说明解析性（复可微）比实光滑强得多。

### 推论 4.1

幂级数 $\sum \alpha_n (z - z_0)^n$ 的和函数 $f(z)$ 的泰勒展式系数为 $\alpha_n = \frac{f^{(n)}(z_0)}{n!}$.

**证明**：由定理4.1的唯一性直接得到。

---

## 7. 解析函数的零点

若 $f(z_0)=0$ 且 $f$ 在 $z_0$ 解析，则泰勒展开为

$f(z) = a_1 (z - z_0) + a_2 (z - z_0)^2 + \cdots$.

若 $a_1 = a_2 = \cdots = a_{m-1}=0$ 但 $a_m \neq 0$，则称 $z_0$ 为 $f$ 的 **$m$ 阶零点**.

**定理**（孤立零点）：若 $f$ 在 $z_0$ 解析且 $f(z_0)=0$，则要么 $f$ 在邻域内恒为零，要么 $z_0$ 是孤立零点（即存在去心邻域内 $f(z)\neq0$）.

**证明**：设 $f(z) = (z-z_0)^m g(z)$，$g(z)$ 在 $z_0$ 解析且 $g(z_0)\neq 0$。由连续性，存在邻域使 $g(z)\neq 0$，故 $f(z)\neq 0$（$z\neq z_0$）。

> 💡 **批注**：这一性质是解析函数唯一性定理的基础。

---

## 8. 正弦函数的欧拉乘积公式

欧拉通过类比多项式因式分解，得到

$\sin \pi z = \pi z \prod_{n=1}^{\infty} \left(1 - \frac{z^2}{n^2}\right)$.

**证明思路**（标准）：考虑 $f(z) = \frac{\sin \pi z}{\pi z}$ 的零点为 $z = \pm 1, \pm 2, \dots$，利用 Mittag-Leffler 或 Weierstrass 因式分解定理构造无穷乘积，并比较对数导数得到恒等式。

利用该公式，令 $z = \frac{1}{2}$ 可得

$\frac{\pi}{2} = \prod_{n=1}^{\infty} \frac{(2n)^2}{(2n-1)(2n+1)}$ （沃利斯乘积）.

令 $z=0$ 附近展开系数对比，可解出巴塞尔问题：

$\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}$.

**欧拉的做法**（原笔记）：将 $\sin \pi z$ 展开为幂级数 $\pi z - \frac{(\pi z)^3}{3!} + \cdots$，而无穷乘积展开后比较 $z^3$ 的系数得到 $\sum 1/n^2 = \pi^2/6$。

> 💡 **批注**：原笔记中“$(1 + 1/Z_1 + ...) = \pi/6$”是笔误，应为平方倒数和。

---

## 9. 洛朗展式

### 定理 7.2（唯一性）

若洛朗级数 $\sum_{n=-\infty}^{\infty} c_n (z - z_0)^n$ 在圆环 $D: R_1 < |z - z_0| < R_2$ 上收敛到 $g(z)$，则系数由下式唯一确定：

$c_n = \frac{1}{2\pi i} \oint_{|z - z_0| = \rho} \frac{g(z)}{(z - z_0)^{n+1}} dz, \quad R_1 < \rho < R_2$.

**证明**：在圆环内取 $\rho$，乘以 $(z-z_0)^{-n-1}$ 并沿圆周积分，利用级数的一致收敛性交换积分与求和，以及 $\oint (z-z_0)^{k-n-1} dz = 2\pi i \delta_{kn}$，即得公式。

### 例子

在圆环 $1 < |z| < 2$ 上展开 $\frac{1}{(z-1)(z-2)}$：

$\frac{1}{(z-1)(z-2)} = \frac{1}{z-2} - \frac{1}{z-1}$.

当 $|z|<2$ 时，$\frac{1}{z-2} = -\frac{1}{2} \frac{1}{1-z/2} = -\frac{1}{2} \sum_{n=0}^\infty (z/2)^n$；当 $|z|>1$ 时，$\frac{1}{z-1} = \frac{1}{z} \frac{1}{1-1/z} = \sum_{n=0}^\infty z^{-n-1}$。合并即得洛朗展式。

---

## 10. 孤立奇点

设 $f$ 在去心圆盘 $0 < |z - z_0| < R$ 内解析，则 $z_0$ 为孤立奇点。洛朗展式为

$f(z) = \sum_{n=-\infty}^{\infty} a_n (z - z_0)^n$.

### 分类

1. **可去奇点**：所有负幂项为零，即 $f(z) = a_0 + a_1 (z - z_0) + \cdots$. 此时 $\lim_{z\to z_0} f(z)$ 存在有限.
2. **极点**：只有有限个负幂项，设最低负幂为 $-m$（$m\ge1$），则称 $z_0$ 为 $m$ 阶极点. 此时 $\lim_{z\to z_0} f(z) = \infty$.
3. **本性奇点**：有无穷多个负幂项. 此时极限不存在（且不是无穷大），例如 $e^{1/z}$ 在 $z=0$.

### 可去奇点的等价条件（定理）

设 $f$ 在 $0<|z-z_0|<R$ 解析，则下列等价：
- $z_0$ 是可去奇点；
- $\lim_{z\to z_0} f(z)$ 存在有限；
- $f$ 在 $z_0$ 的某去心邻域内有界.

**证明**：（3）$\Rightarrow$（1）：由有界性，$|a_n| = \left| \frac{1}{2\pi i} \oint_{|z-z_0|=\rho} \frac{f(z)}{(z-z_0)^{n+1}} dz \right| \le \frac{M}{\rho^{n+1}}$，当 $n<0$ 时令 $\rho \to 0$ 得 $a_n=0$。（1）$\Rightarrow$（2）显然；（2）$\Rightarrow$（3）由极限定义得局部有界。

### 极点的判定（定理 8.2）

$z_0$ 是 $f$ 的极点 $\iff$ $\lim_{z\to z_0} f(z) = \infty$.

**证明**：若 $z_0$ 是极点，则 $f(z) = (z-z_0)^{-m} g(z)$，$g(z_0)\neq 0$，显然极限为 $\infty$。反之，若极限为 $\infty$，则 $1/f(z)$ 在 $z_0$ 有可去奇点且值为 $0$，展开得 $1/f(z) = (z-z_0)^m h(z)$，$h(z_0)\neq 0$，故 $f(z) = (z-z_0)^{-m} / h(z)$ 是极点。

**推论**：$z_0$ 是 $f$ 的 $m$ 阶极点 $\iff$ $\lim_{z\to z_0} (z - z_0)^m f(z) = a_{-m} \neq 0,\infty$.

### 洛必达法则（0/0型或∞/∞型）

若 $f,g$ 在 $z_0$ 解析且均为零点（或极点），则

$\lim_{z\to z_0} \frac{f(z)}{g(z)} = \lim_{z\to z_0} \frac{f'(z)}{g'(z)}$.

**证明**：设 $f(z) = (z-z_0)^m \alpha(z)$，$g(z) = (z-z_0)^n \beta(z)$，$\alpha(z_0),\beta(z_0)\neq 0$，则 $\frac{f}{g} = (z-z_0)^{m-n} \frac{\alpha}{\beta}$。求导后 $\frac{f'}{g'} = (z-z_0)^{m-n} \frac{m\alpha + (z-z_0)\alpha'}{n\beta + (z-z_0)\beta'}$，极限相等。

### 本性奇点的性质（魏尔斯特拉斯-卡索拉蒂定理）

若 $z_0$ 是 $f$ 的本性奇点，则对任意 $y \in \mathbb{C} \cup \{\infty\}$，存在序列 $z_n \to z_0$ 使得 $f(z_n) \to y$. 即在本性奇点附近，函数取值几乎任意.

**证明**（概要）：反证法。若存在某邻域内 $f(z)$ 避开某个值，则可构造有界函数从而得到可去奇点矛盾。

---

## 11. 无穷远点的奇异性

设 $f$ 在区域 $R < |z| < +\infty$ 上解析，则称 $\infty$ 为 $f$ 的孤立奇点. 作变换 $w = 1/z$，研究 $g(w) = f(1/w)$ 在 $w=0$ 的奇性。

### 分类对应

- $\infty$ 是 $f$ 的可去奇点 $\iff$ $g(w)$ 在 $w=0$ 可去 $\iff$ $\lim_{z\to\infty} f(z)$ 存在有限。
- $\infty$ 是 $f$ 的极点 $\iff$ $g(w)$ 在 $w=0$ 是极点 $\iff$ $\lim_{z\to\infty} f(z) = \infty$，且 $f$ 为多项式（若整函数）。
- $\infty$ 是 $f$ 的本性奇点 $\iff$ $g(w)$ 在 $w=0$ 本性奇点 $\iff$ $f$ 是超越整函数（如 $e^z$）。

> 💡 **批注**：原笔记中“$f(z)=z$ 的无穷远点是可去奇点”是错误的，应为极点。

---

## 12. 亚纯函数

若 $f$ 在复平面上除极点外处处解析，则称 $f$ 为亚纯函数. 有理函数是亚纯函数的特例.

**定理**：若 $f$ 是亚纯函数，且 $\infty$ 也是极点或可去奇点，则 $f$ 是有理函数。

**证明思路**：若 $\infty$ 是可去奇点或极点，则 $f$ 在扩充复平面上只有有限个极点（否则会有聚点）。在每个极点处减去其主部，得到整函数，再由 $\infty$ 处性质得其为多项式，从而 $f$ 为有理函数。

> 💡 **批注**：亚纯函数可以看作是解析函数在极点处的推广，其奇异部分可分离。例如 $\pi \cot \pi z$ 的展开式：

$\pi \cot \pi z = \frac{1}{z} + \sum_{n=1}^{\infty} \frac{2z}{z^2 - n^2}$.

该公式可由正弦函数的无穷乘积求对数导数得到。

---

**笔记结束**.