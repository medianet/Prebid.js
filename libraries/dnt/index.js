function _getDNT(win) {
  try {
    const nav = (win && win.navigator) || {};
    const doNotTrack = nav.doNotTrack ?? win?.doNotTrack ?? nav.msDoNotTrack;
    return doNotTrack === '1' || (typeof doNotTrack === 'string' && doNotTrack.toLowerCase() === 'yes');
  } catch (e) {
    return false;
  }
}

export function getDNT(win = window) {
  try {
    return _getDNT(win) || (win !== win.top && _getDNT(win.top));
  } catch (e) {
    return false;
  }
}
