-- Inline code keeps its spaces: \nolinkurl drops them, so each word is set
-- separately and joined with a breakable space.
function Code(el)
  local parts = {}
  for word in el.text:gmatch('%S+') do
    table.insert(parts, '\\nolinkurl{' .. word .. '}')
  end
  return pandoc.RawInline('latex', table.concat(parts, '\\ '))
end

function Image(el)
  if el.src:match('%.png$') then
    el.src = el.src:gsub('%.png$', '.pdf')
    el.attributes.width = '100%'
  end
  return el
end

-- A run-log placeholder such as ⟦runs.total⟧ prints as [runs.total] in a draft.
function Str(el)
  if el.text:find('⟦', 1, true) then
    local latex = el.text:gsub('⟦([%w_.]+)⟧', function(key)
      return '\\texttt{[' .. key:gsub('_', '\\_') .. ']}'
    end)
    return pandoc.RawInline('latex', latex)
  end
end

function Header(el)
  if el.identifier == 'notes-and-references' then
    return {pandoc.RawBlock('latex', '\\newpage'), el,
            pandoc.RawBlock('latex', '\\fontsize{9.5}{12}\\selectfont\\setlist[enumerate]{label=\\arabic*.,itemsep=4pt}')}
  end
end
