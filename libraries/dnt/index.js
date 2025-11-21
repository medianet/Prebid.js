function isDoNotTrackActive(value) {
  if (value == null) {
    return false;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.toLowerCase();
    return normalizedValue === '1' || normalizedValue === 'yes';
  }

  return value === 1;
}

function getTopWindow(win) {
  try {
    return win.top;
  } catch (error) {
    return win;
  }
}

export function getDNT(win = window) {
  const valuesToInspect = [];

  if (!win) {
    return false;
  }

  const topWindow = getTopWindow(win);

  valuesToInspect.push(win.doNotTrack);

  try {
    if (topWindow && topWindow !== win) {
      valuesToInspect.push(topWindow.doNotTrack);
    }
  } catch (error) {}

  const navigatorInstances = new Set();

  if (win.navigator) {
    navigatorInstances.add(win.navigator);
  }

  try {
    if (topWindow && topWindow.navigator) {
      navigatorInstances.add(topWindow.navigator);
    }
  } catch (error) {}

  navigatorInstances.forEach(navigatorInstance => {
    valuesToInspect.push(navigatorInstance.doNotTrack, navigatorInstance.msDoNotTrack);
  });

  return valuesToInspect.some(isDoNotTrackActive);
}
