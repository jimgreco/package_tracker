async page => {
  const search = page.getByRole('searchbox', {name:'Search packages'});
  const button = name => page.getByRole('button', {name,exact:true});
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const query = async value => {
    await search.waitFor();
    for(let i=0;i<30 && await search.inputValue()!==value;i++) await page.waitForTimeout(50);
    check(await search.inputValue()===value, `Expected query ${value}`);
  };
  const selected = async name => check(await button(name).getAttribute('aria-pressed')==='true', `${name} selected`);
  const switchTo = async id => {
    await button('Household settings').click();
    await page.getByLabel('Current household').selectOption(id);
    for(let i=0;i<30 && await page.getByLabel('Current household').inputValue()!==id;i++) await page.waitForTimeout(50);
    check(await page.getByLabel('Current household').inputValue()===id, `Switched ${id}`);
    await button('Packages').click();
  };
  const parkPoll = async () => {
    const gate={}; page.__dashboardQueue.push(gate);
    await page.evaluate(() => { for (const poll of window.__porchTestPolls.values()) poll(); });
    for(let i=0;i<40 && !gate.started;i++) await page.waitForTimeout(50);
    check(gate.started, 'Controlled poll started');
    return gate;
  };
  await button('To collect').click(); await search.fill('CDL coffee');
  await switchTo('other-household'); await button('All packages').click(); await search.fill('Schoolhouse');
  await switchTo('synthetic-household'); await query('CDL coffee');
  const homeKey='porchpong.package-list.v1:["synthetic-user","synthetic-household"]';
  const homeSaved=await page.evaluate(key=>localStorage.getItem(key),homeKey);
  const results=[];
  for(const status of [200,401,500]) {
    const old=await parkPoll();
    await switchTo('other-household'); await query('Schoolhouse'); await selected('All packages');
    await old.release(status); await page.waitForTimeout(100);
    await query('Schoolhouse'); await selected('All packages');
    check(await page.getByRole('heading',{name:'Welcome home.'}).count()===0, 'Old authentication error cannot clear new household');
    check(await page.getByRole('alert').filter({hasText:`Synthetic dashboard failure ${status}`}).count()===0, 'Old failure cannot replace successful household');
    await button('Reset list').click(); await selected('On the way');
    check(await page.evaluate(key=>localStorage.getItem(key),homeKey)===homeSaved,'Reset current household preserves earlier household');
    await button('All packages').click(); await search.fill('Schoolhouse');
    await switchTo('synthetic-household'); await query('CDL coffee'); await selected('To collect');
    results.push(`delayed A ${status} after switched B success`);
  }
  // A confirmed switch with a failed new dashboard must never leave A editable.
  const preSwitch=await parkPoll();
  const switchedFailure={}; page.__dashboardQueue.push(switchedFailure);
  await button('Household settings').click();
  await page.getByLabel('Current household').selectOption('other-household');
  for(let i=0;i<40 && !switchedFailure.started;i++) await page.waitForTimeout(50);
  check(switchedFailure.started,'Switched dashboard request started');
  await button('Packages').click();
  check(await search.count()===0 && await button('Reset list').count()===0,'Old scope is not editable while new household loads');
  await switchedFailure.release(500);
  await page.getByRole('alert').filter({hasText:'Synthetic dashboard failure 500'}).waitFor();
  await preSwitch.release(200); await page.waitForTimeout(100);
  check(await search.count()===0 && await button('Reset list').count()===0,'Old response cannot restore editable scope after switched failure');
  check(await page.evaluate(key=>localStorage.getItem(key),homeKey)===homeSaved,'Failed switch reload preserves A preferences');
  check(await page.getByRole('heading',{name:'Welcome home.'}).count()===0,'Transient dashboard failure does not sign out');
  await button('Try again').click(); await query('Schoolhouse'); await selected('All packages');
  await switchTo('synthetic-household'); await query('CDL coffee');
  results.push('confirmed switch failure hides old scope, preserves it, and retry restores new scope');
  // A late successful poll must not conceal the latest error or change preferences.
  const older=await parkPoll();
  const newest=await parkPoll();
  await newest.release(500);
  await page.getByRole('alert').filter({hasText:'Synthetic dashboard failure 500'}).waitFor();
  await older.release(200); await page.waitForTimeout(100);
  check(await page.getByRole('alert').filter({hasText:'Synthetic dashboard failure 500'}).isVisible(),'Latest error survives older success');
  await query('CDL coffee'); await selected('To collect');
  await button('Try again').click();
  for(let i=0;i<30 && await page.getByRole('alert').filter({hasText:'Synthetic dashboard failure 500'}).count();i++) await page.waitForTimeout(50);
  check(await page.getByRole('alert').filter({hasText:'Synthetic dashboard failure 500'}).count()===0,'Fresh retry recovers latest error');
  results.push('newest failure, older success, fresh retry');
  await page.evaluate(() => {localStorage.removeItem('porchpong.package-list.v1:["synthetic-user","synthetic-household"]');localStorage.removeItem('porchpong.package-list.v1:["synthetic-user","other-household"]');});
  page.__preferenceWrites.length=0;
  await page.reload();
  await query(''); await selected('On the way');
  return {passed:true,scenarios:results,oldHouseholdPreferencesPreserved:true};
}
