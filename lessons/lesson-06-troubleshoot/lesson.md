# Lesson 6: Troubleshoot a broken fabric

Someone has been "tidying up" this leaf-spine network and it no longer works. There are **three separate faults**. Find and fix all of them so every check passes.

You know what a healthy lab looks like from the `leaf-spine` lab: every switch at **BGP 2/2**, every cable green, h1 ↔ h2 pinging.

## How to hunt
1. **Deploy**, then **Check my work** to see which checks fail. Failures tell you *where* to look, not *why*.
2. **Read the canvas.** Red cables mean a port is down. A red **BGP** badge means a peer that isn't Established.
3. **Click a switch** to see its peers and their states. `Active`/`Connect` means it can't even open TCP to the peer, while `Established` with no prefixes is a different problem altogether.
4. **Open a terminal** and ask FRR:
   - `vtysh -c "show bgp summary"`
   - `vtysh -c "show bgp neighbors 10.1.1.1"`: read the last error and the state
   - `vtysh -c "show ip bgp"`: what's being learned?
   - `show interfaces status`
5. Fix it in **Configure**, **Save & apply**, and check again.

## Hints (try without them first)
<details><summary>Hint 1</summary>One leaf's peer is configured with an AS number the spine doesn't have. Look for "Bad Peer AS" in <code>show bgp neighbors</code>.</details>
<details><summary>Hint 2</summary>One host can't reach its own gateway. Look at that leaf's Ports tab.</details>
<details><summary>Hint 3</summary>One spine's sessions are up but it advertises nothing. Remember the eBGP policy tick box from lesson 2.</details>
